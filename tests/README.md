# Tests

End-to-end tests run the web app in Chromium with [Playwright for Python](https://playwright.dev/python/).
They draw with simulated pen, mouse and finger input, export a PDF and check its ink
annotations, and sync simulated devices through mocks of the GitHub API and of Google
sign-in and the Google Drive API.

```sh
pip install playwright && playwright install chromium
node tests/make_test_pdf.mjs   # writes tests/out/test.pdf and tests/out/big.pdf
python3 tests/e2e_ui.py        # viewing, drawing, erasing, undo, layouts, export
python3 tests/e2e_sync.py      # GitHub sync between devices, automatic sync, blank pages (mock API)
python3 tests/e2e_drive.py     # Google sign-in (pop-up, redirect, desktop) and Drive sync (mock API)
python3 tests/e2e_phone.py     # a phone: taps, finger writing, hand tool, switching to pen-only
python3 tests/e2e_fullscreen.py  # full screen two-page reading, swipes and taps, go to page
python3 tests/e2e_tools.py     # partial eraser, lasso, pages panel and contents, blank pages
python3 tests/e2e_update.py    # a new web version arrives whole; the app still opens offline
```
