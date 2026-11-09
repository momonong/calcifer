import unittest
from taskboard.count import count_open

class CountTests(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(count_open([]), 0)

    def test_status(self):
        self.assertEqual(count_open([{"status": "open"}, {"status": "done"}]), 1)
