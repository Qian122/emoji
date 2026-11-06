import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import main


class AiServiceTests(unittest.TestCase):
    def test_health_reports_runtime_capabilities(self):
        result = asyncio.run(main.health())
        self.assertEqual(result["status"], "UP")
        self.assertIn("visionAvailable", result)
        self.assertIn("threshold", result)

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


if __name__ == "__main__":
    unittest.main()
