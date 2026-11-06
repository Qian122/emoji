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
from datetime import datetime, timezone
from pathlib import Path
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
    if longest_edge <= 0 or longest_edge >= 1280:
        return image
    scale = min(2.0, 1280 / longest_edge)
    return cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)


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
        scores = result.get("emotion") or {}
        dominant = result.get("dominant_emotion")
        if not dominant or dominant not in scores:
            continue
        normalized.append({
            "emojiType": EMOTION_MAP.get(dominant, "CALM"),
            "confidence": round(float(scores[dominant]) / 100, 4),
            "rawEmotion": dominant,
            "detectorBackend": detector_backend,
        })
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
    results = await asyncio.to_thread(infer_emotions, image)
    accepted = []
    filtered = []
    for result in results:
        if result["confidence"] < CONFIDENCE_THRESHOLD:
            filtered.append(result)
            continue
        backend = await post_result(session_id, result["emojiType"], result["confidence"], device_id)
        accepted.append({**result, "backend": backend})
    return {"faces": len(results), "accepted": accepted, "filtered": filtered, "threshold": CONFIDENCE_THRESHOLD}


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
