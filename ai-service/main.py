"""课堂视频情绪推理服务。

默认只在内存中处理采样帧，不保存原始视频或人脸图像。DeepFace 不可用时，
仍可通过 /simulate 验证 AI 到后端的数据链路。
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import random
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

try:
    import cv2
    import numpy as np
except ImportError:  # 允许未安装视觉依赖时使用 /health 和 /simulate
    cv2 = None
    np = None

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("emoji-ai-service")


def config_value(name: str, default: str) -> str:
    if name in os.environ:
        return os.environ[name]
    for env_path in (Path.cwd() / ".env", Path(__file__).resolve().parent.parent / ".env"):
        if not env_path.is_file():
            continue
        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            if key.strip() == name:
                return value.strip()
    return default


BACKEND_URL = os.getenv("AI_BACKEND_URL", "http://localhost:3000").rstrip("/")
AI_TOKEN = config_value("AI_SERVICE_TOKEN", "development-ai-token")
CONFIDENCE_THRESHOLD = float(config_value("AI_CONFIDENCE_THRESHOLD", "0.65"))
SAMPLE_INTERVAL_SECONDS = float(config_value("AI_SAMPLE_INTERVAL_SECONDS", "3"))
CAMERA_INDEX = int(config_value("AI_CAMERA_INDEX", "0"))
FACE_DETECTOR_BACKENDS = tuple(
    backend.strip()
    for backend in config_value("AI_DETECTOR_BACKENDS", "opencv,mtcnn").split(",")
    if backend.strip()
)
FACE_EXPAND_PERCENTAGE = int(config_value("AI_FACE_EXPAND_PERCENTAGE", "15"))
TEMPORAL_WINDOW = max(1, min(5, int(config_value("AI_TEMPORAL_WINDOW", "3"))))
TEMPORAL_TTL_SECONDS = max(3.0, float(config_value("AI_TEMPORAL_TTL_SECONDS", "15")))
MIN_TEMPORAL_AGREEMENT = float(config_value("AI_MIN_TEMPORAL_AGREEMENT", "0.67"))
MIN_EMOTION_MARGIN = float(config_value("AI_MIN_EMOTION_MARGIN", "0.12"))
CONFUSED_MIN_MARGIN = float(config_value("AI_CONFUSED_MIN_MARGIN", "0.20"))
CLASS_CONFIDENCE_THRESHOLDS = {
    "happy": float(config_value("AI_THRESHOLD_HAPPY", "0.68")),
    "neutral": float(config_value("AI_THRESHOLD_NEUTRAL", "0.70")),
    "fear": float(config_value("AI_THRESHOLD_CONFUSED", "0.75")),
    "disgust": float(config_value("AI_THRESHOLD_DISGUST", "0.72")),
    "angry": float(config_value("AI_THRESHOLD_ANGRY", "0.70")),
    "sad": float(config_value("AI_THRESHOLD_SAD", "0.70")),
    "surprise": float(config_value("AI_THRESHOLD_SURPRISED", "0.70")),
}

EMOTION_MAP = {
    "happy": "HAPPY",
    "neutral": "CALM",
    "fear": "CONFUSED",
    "disgust": "ANGRY",
    "angry": "ANGRY",
    "sad": "SAD",
    "surprise": "SURPRISED",
}

app = FastAPI(title="课堂情绪 AI 推理服务", version="1.0.0")
camera_task: asyncio.Task | None = None
temporal_buffers: dict[str, deque] = {}


class FrameRequest(BaseModel):
    session_id: int = Field(gt=0, alias="sessionId")
    image_base64: str = Field(alias="imageBase64")
    device_id: str = Field(default="ai-upload", alias="deviceId", max_length=100)


class SimulateRequest(BaseModel):
    session_id: int = Field(gt=0, alias="sessionId")
    emoji_type: Literal["HAPPY", "CALM", "CONFUSED", "SAD", "ANGRY", "SURPRISED"] | None = Field(default=None, alias="emojiType")
    confidence: float = Field(default=0.9, ge=0, le=1)
    device_id: str = Field(default="ai-simulator", alias="deviceId")


class CameraRequest(BaseModel):
    session_id: int = Field(gt=0, alias="sessionId")
    camera_index: int = Field(default=CAMERA_INDEX, alias="cameraIndex")
    device_id: str = Field(default="classroom-camera", alias="deviceId")


def require_vision_dependencies() -> None:
    if cv2 is None or np is None:
        raise HTTPException(status_code=503, detail="OpenCV 尚未安装，请先使用 /simulate 验证数据链路。")


def decode_image(data: str):
    require_vision_dependencies()
    encoded = data.split(",", 1)[-1]
    try:
        buffer = np.frombuffer(base64.b64decode(encoded), dtype=np.uint8)
        image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="图像数据无法解析。") from exc
    if image is None:
        raise HTTPException(status_code=400, detail="图像数据无法解析。")
    return image


def prepare_fallback_image(image):
    """放大小分辨率画面，帮助兜底检测器发现远距离和小尺寸人脸。"""
    if cv2 is None or not hasattr(image, "shape") or len(image.shape) < 2:
        return image
    height, width = image.shape[:2]
    longest_edge = max(height, width)
    if 0 < longest_edge < 1280:
        scale = min(2.0, 1280 / longest_edge)
        return cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    return image


def normalize_emotion_scores(scores: dict) -> dict[str, float]:
    normalized = {str(name): max(0.0, float(value)) for name, value in scores.items()}
    total = sum(normalized.values())
    if total <= 0:
        return {}
    return {name: value / total for name, value in normalized.items()}


def build_emotion_result(scores: dict, detector_backend: str, temporal_frames: int = 1, agreement: float = 1.0) -> dict | None:
    normalized_scores = normalize_emotion_scores(scores)
    if not normalized_scores:
        return None
    ranked = sorted(normalized_scores.items(), key=lambda item: item[1], reverse=True)
    dominant, confidence = ranked[0]
    runner_up, runner_up_confidence = ranked[1] if len(ranked) > 1 else (None, 0.0)
    return {
        "emojiType": EMOTION_MAP.get(dominant, "CALM"),
        "confidence": round(confidence, 4),
        "rawEmotion": dominant,
        "runnerUpEmotion": runner_up,
        "runnerUpConfidence": round(runner_up_confidence, 4),
        "margin": round(confidence - runner_up_confidence, 4),
        "emotionScores": {name: round(value, 4) for name, value in normalized_scores.items()},
        "detectorBackend": detector_backend,
        "temporalFrames": temporal_frames,
        "agreement": round(agreement, 4),
    }


def assess_image_quality(image) -> dict:
    if cv2 is None or not hasattr(image, "shape"):
        return {"brightness": None, "sharpness": None, "warnings": []}
    try:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        brightness = float(gray.mean())
        sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    except Exception:  # noqa: BLE001
        return {"brightness": None, "sharpness": None, "warnings": []}
    warnings = []
    if brightness < 45:
        warnings.append("LOW_LIGHT")
    elif brightness > 220:
        warnings.append("OVEREXPOSED")
    if sharpness < 35:
        warnings.append("BLURRY")
    return {"brightness": round(brightness, 1), "sharpness": round(sharpness, 1), "warnings": warnings}


def has_severe_quality_issue(quality: dict) -> bool:
    brightness = quality.get("brightness")
    sharpness = quality.get("sharpness")
    return brightness is not None and sharpness is not None and (brightness < 25 or brightness > 235 or sharpness < 15)


def stabilize_result(session_id: int, device_id: str, result: dict) -> tuple[dict | None, dict | None]:
    if TEMPORAL_WINDOW <= 1:
        return result, None
    key = f"{session_id}:{device_id}"
    now = monotonic()
    for stale_key, stale_buffer in list(temporal_buffers.items()):
        if not stale_buffer or now - stale_buffer[-1]["timestamp"] > TEMPORAL_TTL_SECONDS:
            temporal_buffers.pop(stale_key, None)
    buffer = temporal_buffers.setdefault(key, deque(maxlen=TEMPORAL_WINDOW))
    while buffer and now - buffer[0]["timestamp"] > TEMPORAL_TTL_SECONDS:
        buffer.popleft()
    buffer.append({"timestamp": now, "scores": result["emotionScores"], "dominant": result["rawEmotion"]})
    if len(buffer) < TEMPORAL_WINDOW:
        return None, {"framesCollected": len(buffer), "framesRequired": TEMPORAL_WINDOW}

    emotion_names = set().union(*(item["scores"].keys() for item in buffer))
    fused_scores = {
        emotion: sum(item["scores"].get(emotion, 0.0) for item in buffer) / len(buffer)
        for emotion in emotion_names
    }
    fused_dominant = max(fused_scores, key=fused_scores.get)
    agreement = sum(item["dominant"] == fused_dominant for item in buffer) / len(buffer)
    stabilized = build_emotion_result(fused_scores, result["detectorBackend"], len(buffer), agreement)
    temporal_buffers.pop(key, None)
    return stabilized, None


def filter_reason(result: dict) -> tuple[str | None, float, float]:
    confidence_threshold = max(CONFIDENCE_THRESHOLD, CLASS_CONFIDENCE_THRESHOLDS.get(result["rawEmotion"], CONFIDENCE_THRESHOLD))
    margin_threshold = CONFUSED_MIN_MARGIN if result["rawEmotion"] == "fear" else MIN_EMOTION_MARGIN
    if result["confidence"] < confidence_threshold:
        return "LOW_CONFIDENCE", confidence_threshold, margin_threshold
    if result["margin"] < margin_threshold:
        return "AMBIGUOUS", confidence_threshold, margin_threshold
    if result.get("temporalFrames", 1) > 1 and result.get("agreement", 1.0) < MIN_TEMPORAL_AGREEMENT:
        return "UNSTABLE", confidence_threshold, margin_threshold
    return None, confidence_threshold, margin_threshold


def infer_emotions(image) -> list[dict]:
    require_vision_dependencies()
    try:
        from deepface import DeepFace
    except ImportError as exc:
        raise HTTPException(status_code=503, detail="DeepFace 尚未安装，请使用 /simulate 验证数据链路。") from exc

    results = None
    detector_backend = None
    last_error = None
    fallback_image = None
    for index, backend in enumerate(FACE_DETECTOR_BACKENDS):
        try:
            if index > 0 and fallback_image is None:
                fallback_image = prepare_fallback_image(image)
            results = DeepFace.analyze(
                img_path=fallback_image if index > 0 else image,
                actions=["emotion"],
                enforce_detection=True,
                detector_backend=backend,
                align=True,
                expand_percentage=FACE_EXPAND_PERCENTAGE,
                silent=True,
            )
            detector_backend = backend
            break
        except ValueError as exc:
            if "Face could not be detected" in str(exc):
                logger.info("face not detected with %s, trying fallback", backend)
                continue
            last_error = exc
            logger.warning("detector %s failed: %s", backend, exc)
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            logger.warning("detector %s failed: %s", backend, exc)

    if results is None:
        if last_error is not None:
            logger.error("all configured face detectors failed: %s", last_error)
        return []

    if isinstance(results, dict):
        results = [results]
    normalized = []
    for result in results:
        emotion_result = build_emotion_result(result.get("emotion") or {}, detector_backend)
        if emotion_result:
            normalized.append(emotion_result)
    return normalized


async def post_result(session_id: int, emoji_type: str, confidence: float, device_id: str) -> dict:
    payload = {
        "sessionId": session_id,
        "emojiType": emoji_type,
        "confidence": confidence,
        "recordedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "deviceId": device_id,
        "anonymous": True,
    }
    headers = {"X-AI-Token": AI_TOKEN, "X-Confidence-Threshold": str(CONFIDENCE_THRESHOLD)}
    for attempt in range(1, 4):
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.post(f"{BACKEND_URL}/api/ai/emoji-results", json=payload, headers=headers)
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, OSError) as exc:
            logger.warning("backend post attempt %s failed: %s", attempt, exc)
            if attempt == 3:
                raise HTTPException(status_code=502, detail="后端暂不可用，重试后仍未入库。") from exc
            await asyncio.sleep(2 ** (attempt - 1))
    raise RuntimeError("unreachable")


async def process_image(session_id: int, image, device_id: str) -> dict:
    quality = assess_image_quality(image)
    results = await asyncio.to_thread(infer_emotions, image)
    accepted = []
    filtered = []
    pending = None
    if len(results) == 1:
        stabilized, pending = stabilize_result(session_id, device_id, results[0])
        results = [stabilized] if stabilized else []
    for result in results:
        reason, confidence_threshold, margin_threshold = filter_reason(result)
        evaluated = {**result, "confidenceThreshold": confidence_threshold, "marginThreshold": margin_threshold}
        if has_severe_quality_issue(quality):
            reason = "LOW_IMAGE_QUALITY"
        if reason:
            filtered.append({**evaluated, "reason": reason})
            continue
        backend = await post_result(session_id, result["emojiType"], result["confidence"], device_id)
        accepted.append({**evaluated, "backend": backend})
    detected_faces = 1 if pending else len(results)
    return {
        "faces": detected_faces,
        "accepted": accepted,
        "filtered": filtered,
        "pending": pending,
        "quality": quality,
        "threshold": CONFIDENCE_THRESHOLD,
        "temporalWindow": TEMPORAL_WINDOW,
    }


async def camera_loop(session_id: int, camera_index: int, device_id: str) -> None:
    require_vision_dependencies()
    capture = cv2.VideoCapture(camera_index)
    if not capture.isOpened():
        logger.error("camera %s could not be opened", camera_index)
        return
    logger.info("camera sampling started: camera=%s session=%s", camera_index, session_id)
    try:
        while True:
            ok, frame = await asyncio.to_thread(capture.read)
            if ok:
                try:
                    await process_image(session_id, frame, device_id)
                except Exception:  # noqa: BLE001
                    logger.exception("camera frame processing failed")
            await asyncio.sleep(SAMPLE_INTERVAL_SECONDS)
    finally:
        capture.release()
        logger.info("camera sampling stopped")


@app.get("/health")
async def health() -> dict:
    return {
        "status": "UP",
        "backendUrl": BACKEND_URL,
        "threshold": CONFIDENCE_THRESHOLD,
        "cameraRunning": bool(camera_task and not camera_task.done()),
        "visionAvailable": cv2 is not None and np is not None,
        "detectorBackends": list(FACE_DETECTOR_BACKENDS),
        "faceExpandPercentage": FACE_EXPAND_PERCENTAGE,
        "temporalWindow": TEMPORAL_WINDOW,
        "minimumEmotionMargin": MIN_EMOTION_MARGIN,
        "minimumTemporalAgreement": MIN_TEMPORAL_AGREEMENT,
        "classThresholds": CLASS_CONFIDENCE_THRESHOLDS,
    }


@app.post("/analyze-frame")
async def analyze_frame(request: FrameRequest) -> dict:
    return await process_image(request.session_id, decode_image(request.image_base64), request.device_id)


@app.post("/simulate")
async def simulate(request: SimulateRequest) -> dict:
    emoji_type = request.emoji_type or random.choice(list(set(EMOTION_MAP.values())))
    if request.confidence < CONFIDENCE_THRESHOLD:
        return {"accepted": False, "reason": "LOW_CONFIDENCE", "threshold": CONFIDENCE_THRESHOLD}
    return await post_result(request.session_id, emoji_type, request.confidence, request.device_id)


@app.post("/camera/start")
async def start_camera(request: CameraRequest) -> dict:
    global camera_task
    require_vision_dependencies()
    if camera_task and not camera_task.done():
        raise HTTPException(status_code=409, detail="摄像头采样任务已在运行。")
    camera_task = asyncio.create_task(camera_loop(request.session_id, request.camera_index, request.device_id))
    return {"started": True, "sessionId": request.session_id, "cameraIndex": request.camera_index}


@app.post("/camera/stop")
async def stop_camera() -> dict:
    global camera_task
    if not camera_task or camera_task.done():
        return {"stopped": False, "reason": "NOT_RUNNING"}
    camera_task.cancel()
    try:
        await camera_task
    except asyncio.CancelledError:
        pass
    camera_task = None
    return {"stopped": True}
