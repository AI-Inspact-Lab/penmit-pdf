# Penmit PDF (팬밋 PDF)

어느 기기에서든 PDF를 보고, 펜으로 필기하고, **내 GitHub 저장소**에 보관하는 무료 앱
<br>
Read and handwrite on PDFs on any device, and keep them in **your own GitHub repository**.

[한국어](#한국어) · [English](#english) · [다운로드 · Download](https://github.com/AI-Inspact-Lab/penmit-pdf/releases) · [웹에서 열기 · Open in the browser](https://ai-inspact-lab.github.io/penmit-pdf/)

---

## 한국어

### 왜 만들었나

태블릿 필기 앱은 기기마다 따로 놀아요. 아이패드에서 쓴 필기를 갤럭시탭이나 윈도우에서 이어서 보려면 유료 클라우드에 가입해야 하는 경우가 많아요. 팬밋 PDF는 **서버가 없어요.** 필기는 각자의 GitHub 저장소에 저장되니 운영 비용이 들지 않고, 데이터는 온전히 내 것이에요.

### 핵심 기능

1. **PDF 보기:** 한쪽 보기, 두쪽 보기, 표지 따로 두쪽 보기. 확대·축소와 두 손가락 핀치를 지원해요.
2. **필기:** 펜, 형광펜, 지우개를 쓸 수 있어요. 애플펜슬, 갤럭시 S펜, 서피스펜, 와콤처럼 브라우저가 인식하는 펜이면 필압까지 받아요. 펜으로 쓰는 동안 손바닥 터치는 무시해요.
3. **GitHub 동기화:** 내 비공개 저장소에 PDF와 필기를 올리고, 다른 기기에서 받아요. 두 기기에서 따로 쓴 필기도 자동으로 합쳐요.

내보내기를 하면 필기가 **PDF 표준 잉크 주석**으로 들어간 PDF가 만들어져요. 아크로뱃, 맥 미리보기, 브라우저 같은 다른 PDF 프로그램에서도 그대로 보여요.

### 설치

| 기기 | 방법 |
| --- | --- |
| 아이폰·아이패드 | 사파리에서 [웹앱](https://ai-inspact-lab.github.io/penmit-pdf/)을 열고 공유 → **홈 화면에 추가** |
| 윈도우 | [Releases](https://github.com/AI-Inspact-Lab/penmit-pdf/releases)에서 `Penmit-PDF-Setup-x.y.z.exe` (설치형) 또는 `-portable.exe` |
| 리눅스 | `Penmit-PDF-x.y.z-x86_64.AppImage` 또는 `.deb` |
| 안드로이드 | `Penmit-PDF-x.y.z.apk` ('출처를 알 수 없는 앱' 설치 허용) |
| 그 밖의 기기 | 크롬·엣지·사파리에서 웹앱을 열면 돼요 |

윈도우에서 처음 실행할 때 "Windows의 PC 보호" 창이 뜨면 **추가 정보 → 실행**을 누르세요. 유료 코드 서명 인증서를 쓰지 않아서 생기는 안내예요.

### GitHub 동기화 설정 (한 번만)

1. GitHub에서 **비공개(Private)** 저장소를 하나 만들어요. 예: `penmit-notes`
2. [Fine-grained 토큰](https://github.com/settings/personal-access-tokens/new)을 만들어요.
   - Repository access: **Only select repositories** → 방금 만든 저장소
   - Permissions → Repository permissions → **Contents: Read and write**
3. 팬밋 PDF의 **설정**에 소유자(내 GitHub 아이디), 저장소 이름, 토큰을 넣고 **연결 확인** → **저장**
4. **동기화**를 누르면 끝이에요. 다른 기기에서도 같은 저장소와 토큰을 넣으면 돼요.

저장소에는 이렇게 저장돼요.

```
penmit/<PDF의 SHA-256>/document.pdf   원본 PDF (한 번만 올림)
penmit/<PDF의 SHA-256>/meta.json      파일 이름, 쪽수
penmit/<PDF의 SHA-256>/ink.json       필기 (작은 텍스트 파일)
```

필기는 원본 PDF와 따로 저장해서, 필기할 때마다 큰 PDF를 다시 올리지 않아요. 문서를 닫을 때 바뀐 게 있으면 자동으로 동기화해요.

### 쓰는 법

- **펜:** 펜으로 바로 필기하고, 손가락으로는 화면을 움직여요. 펜이 없는 기기는 설정에서 **손가락으로도 필기하기**를 켜세요. 그때는 두 손가락으로 움직이고 확대해요.
- **확대:** 두 손가락 핀치, Ctrl + 마우스 휠, 위쪽의 −/+ 버튼. 퍼센트를 누르면 폭에 맞춰요.
- **단축키:** P 펜, H 형광펜, E 지우개, V 손, Ctrl+Z 실행 취소, Ctrl+Shift+Z 또는 Ctrl+Y 다시 실행

### 개인정보

- 서버가 없어요. PDF와 필기는 기기 안(IndexedDB)과 내 GitHub 저장소에만 있어요.
- 토큰은 그 기기의 브라우저 저장소에만 보관돼요. 공용 컴퓨터에서는 쓰지 마세요.
- 토큰은 저장소 하나, Contents 권한 하나만 주세요. 유출되더라도 그 저장소 밖으로는 영향이 없어요.

### 베타 안내 (0.1.0)

- 암호가 걸린 PDF는 아직 열 수 없어요.
- 내보낸 PDF를 다시 열면 필기가 보이기는 하지만, 지우거나 고칠 수는 없어요.
- 글자 입력, 도형, 페이지 추가는 아직 없어요.

---

## English

### Why

Handwriting apps keep your notes inside their own cloud. Penmit PDF has **no server**: your PDFs and notes live on your devices and in a GitHub repository you own, so it costs nothing to run and the data stays yours.

### Features

1. **Read PDFs:** single page, two pages, or cover plus two pages; zoom and two-finger pinch.
2. **Handwrite:** pen, highlighter and eraser, with pressure from Apple Pencil, Galaxy S Pen, Surface Pen, Wacom and any other pen the browser sees. Palm touches are ignored while the pen writes.
3. **Sync through GitHub:** PDFs and notes go to your private repository and come back on your other devices. Notes written on two devices at once are merged.

**Export** writes the notes into a copy of the PDF as standard ink annotations, which Acrobat, Preview, browsers and other PDF readers show as drawn.

### Install

| Device | How |
| --- | --- |
| iPhone, iPad | Open the [web app](https://ai-inspact-lab.github.io/penmit-pdf/) in Safari → Share → **Add to Home Screen** |
| Windows | `Penmit-PDF-Setup-x.y.z.exe` or `-portable.exe` from [Releases](https://github.com/AI-Inspact-Lab/penmit-pdf/releases) |
| Linux | `Penmit-PDF-x.y.z-x86_64.AppImage` or `.deb` |
| Android | `Penmit-PDF-x.y.z.apk` (allow installs from unknown sources) |
| Anything else | The web app in Chrome, Edge or Safari |

On first launch Windows may show "Windows protected your PC": choose **More info → Run anyway**. The installer is not signed with a paid certificate.

### Set up GitHub sync (once)

1. Create a **private** repository, e.g. `penmit-notes`.
2. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with access to **only that repository** and **Contents: Read and write**.
3. In Penmit PDF, open **Settings**, enter the owner, repository and token, choose **Test connection**, then **Save**.
4. Press **Sync**. Use the same repository and token on your other devices.

Each PDF is stored as `penmit/<sha256>/document.pdf` (uploaded once), `meta.json` and `ink.json` (the notes, as small text). Closing a document syncs it if anything changed.

### Privacy

No server is involved. Data stays in the device's IndexedDB and in your repository. The token is kept only in that device's browser storage, so don't use it on a shared computer, and limit it to one repository with Contents permission.

---

## Development

The web app in `web/` is plain HTML, CSS and JavaScript modules: there is no build step.

```sh
python3 -m http.server -d web 8000      # then open http://localhost:8000
```

| Part | Where | Build |
| --- | --- | --- |
| Web app (iPhone, iPad, browsers) | `web/` | deployed to GitHub Pages by `.github/workflows/pages.yml` |
| Windows, Linux | `desktop/` (Electron) | `cd desktop && npm install && cp -r ../web app && npm run dist` |
| Android | `mobile/` (Capacitor) | `(cd mobile && npm install) && scripts/prepare-android.sh 0.1.0 1`, then `./gradlew assembleDebug` in `mobile/android` |
| All apps for a release | `.github/workflows/release.yml` | runs when a GitHub Release is published and attaches the files |

Tests are in [`tests/`](tests/README.md).

## License

See [LICENSE](LICENSE). Bundled third-party software keeps its own license: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
