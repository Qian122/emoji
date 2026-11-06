import asyncio
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch

import main


class AiServiceTests(unittest.TestCase):
    def setUp(self):
        main.temporal_buffers.clear()

    def test_health_reports_runtime_capabilities(self):
        result = asyncio.run(main.health())
        self.assertEqual(result["status"], "UP")
        self.assertIn("visionAvailable", result)
        self.assertIn("threshold", result)
        self.assertIn("detectorBackends", result)
        self.assertIn("temporalWindow", result)

    def test_low_confidence_simulation_is_filtered(self):
        request = main.SimulateRequest(sessionId=1, emojiType="HAPPY", confidence=0.1)
        result = asyncio.run(main.simulate(request))
        self.assertFalse(result["accepted"])
        self.assertEqual(result["reason"], "LOW_CONFIDENCE")

    def test_simulation_posts_anonymous_result(self):
        request = main.SimulateRequest(sessionId=1, emojiType="CALM", confidence=0.92)
        expected = {"success": True, "data": {"accepted": True}}
        with patch.object(main, "post_result", new=AsyncMock(return_value=expected)) as mocked:
            result = asyncio.run(main.simulate(request))
        self.assertEqual(result, expected)
        mocked.assert_awaited_once_with(1, "CALM", 0.92, "ai-simulator")

    def test_camera_requires_opencv_when_visual_runtime_is_missing(self):
        if main.cv2 is not None and main.np is not None:
            self.skipTest("OpenCV is installed in this environment")
        with self.assertRaises(main.HTTPException) as context:
            main.require_vision_dependencies()
        self.assertEqual(context.exception.status_code, 503)

    def test_inference_requires_a_detected_face(self):
        calls = []

        class FakeDeepFace:
            @staticmethod
            def analyze(**kwargs):
                calls.append(kwargs)
                raise ValueError("Face could not be detected in numpy array.")

        fake_module = types.ModuleType("deepface")
        fake_module.DeepFace = FakeDeepFace
        with (
            patch.dict(sys.modules, {"deepface": fake_module}),
            patch.object(main, "cv2", object()),
            patch.object(main, "np", object()),
        ):
            result = main.infer_emotions(object())

        self.assertEqual(result, [])
        self.assertEqual([call["detector_backend"] for call in calls], list(main.FACE_DETECTOR_BACKENDS))
        self.assertTrue(all(call["enforce_detection"] for call in calls))

    def test_inference_falls_back_to_sensitive_detector(self):
        calls = []

        class FakeDeepFace:
            @staticmethod
            def analyze(**kwargs):
                calls.append(kwargs)
                if kwargs["detector_backend"] == "opencv":
                    raise ValueError("Face could not be detected in numpy array.")
                return [{"dominant_emotion": "happy", "emotion": {"happy": 91.25, "neutral": 8.75}}]

        fake_module = types.ModuleType("deepface")
        fake_module.DeepFace = FakeDeepFace
        source_image = object()
        fallback_image = object()
        with (
            patch.dict(sys.modules, {"deepface": fake_module}),
            patch.object(main, "cv2", object()),
            patch.object(main, "np", object()),
            patch.object(main, "FACE_DETECTOR_BACKENDS", ("opencv", "mtcnn")),
            patch.object(main, "prepare_fallback_image", return_value=fallback_image) as prepared,
        ):
            result = main.infer_emotions(source_image)

        self.assertEqual([call["detector_backend"] for call in calls], ["opencv", "mtcnn"])
        self.assertIs(calls[0]["img_path"], source_image)
        self.assertIs(calls[1]["img_path"], fallback_image)
        prepared.assert_called_once_with(source_image)
        self.assertEqual(result[0]["emojiType"], "HAPPY")
        self.assertEqual(result[0]["confidence"], 0.9125)
        self.assertEqual(result[0]["detectorBackend"], "mtcnn")

    def test_temporal_fusion_requires_multiple_consistent_frames(self):
        inference = main.build_emotion_result({"happy": 90, "neutral": 10}, "mtcnn")
        expected = {"success": True, "data": {"accepted": True}}
        with (
            patch.object(main, "TEMPORAL_WINDOW", 3),
            patch.object(main, "infer_emotions", return_value=[inference]),
            patch.object(main, "assess_image_quality", return_value={"brightness": 100, "sharpness": 100, "warnings": []}),
            patch.object(main, "post_result", new=AsyncMock(return_value=expected)) as posted,
        ):
            first = asyncio.run(main.process_image(1, object(), "camera-a"))
            second = asyncio.run(main.process_image(1, object(), "camera-a"))
            third = asyncio.run(main.process_image(1, object(), "camera-a"))

        self.assertEqual(first["pending"], {"framesCollected": 1, "framesRequired": 3})
        self.assertEqual(second["pending"], {"framesCollected": 2, "framesRequired": 3})
        self.assertIsNone(third["pending"])
        self.assertEqual(third["accepted"][0]["temporalFrames"], 3)
        self.assertEqual(third["accepted"][0]["agreement"], 1.0)
        posted.assert_awaited_once_with(1, "HAPPY", 0.9, "camera-a")

    def test_close_competing_emotions_are_marked_ambiguous(self):
        result = main.build_emotion_result({"angry": 55, "sad": 45}, "mtcnn", temporal_frames=3, agreement=1.0)
        with (
            patch.object(main, "CONFIDENCE_THRESHOLD", 0.5),
            patch.object(main, "CLASS_CONFIDENCE_THRESHOLDS", {"angry": 0.5}),
            patch.object(main, "MIN_EMOTION_MARGIN", 0.15),
        ):
            reason, confidence_threshold, margin_threshold = main.filter_reason(result)

        self.assertEqual(reason, "AMBIGUOUS")
        self.assertEqual(confidence_threshold, 0.5)
        self.assertEqual(margin_threshold, 0.15)

    def test_severe_image_quality_is_filtered_without_database_write(self):
        inference = main.build_emotion_result({"happy": 95, "neutral": 5}, "mtcnn")
        with (
            patch.object(main, "TEMPORAL_WINDOW", 1),
            patch.object(main, "infer_emotions", return_value=[inference]),
            patch.object(main, "assess_image_quality", return_value={"brightness": 12, "sharpness": 8, "warnings": ["LOW_LIGHT", "BLURRY"]}),
            patch.object(main, "post_result", new=AsyncMock()) as posted,
        ):
            result = asyncio.run(main.process_image(1, object(), "camera-quality"))

        self.assertEqual(result["filtered"][0]["reason"], "LOW_IMAGE_QUALITY")
        posted.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
