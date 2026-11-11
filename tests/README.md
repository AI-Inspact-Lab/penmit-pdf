# Tests

End-to-end tests run the web app in Chromium with [Playwright for Python](https://playwright.dev/python/).
They draw with simulated pen, mouse and finger input, export a PDF and check its ink
annotations, and sync two simulated devices through a mock of the GitHub API.

```sh
pip install playwright && playwright install chromium
node tests/make_test_pdf.mjs   # writes tests/out/test.pdf
python3 tests/e2e_ui.py        # viewing, drawing, erasing, undo, layouts, export
python3 tests/e2e_sync.py      # GitHub sync between two devices (mock API)
```
