import asyncio
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch

import main


class AiServiceTests(unittest.TestCase):
    def test_health_reports_runtime_capabilities(self):
        result = asyncio.run(main.health())
        self.assertEqual(result["status"], "UP")
        self.assertIn("visionAvailable", result)
        self.assertIn("threshold", result)
        self.assertIn("detectorBackends", result)

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
                return [{"dominant_emotion": "happy", "emotion": {"happy": 91.25}}]

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


if __name__ == "__main__":
    unittest.main()
