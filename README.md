# Penmit PDF (팬밋 PDF)

어느 기기에서든 PDF를 보고, 펜으로 필기하고, **내 구글 드라이브나 GitHub**에 보관하는 무료 앱
<br>
Read and handwrite on PDFs on any device, and keep them in **your own Google Drive or GitHub**.

[한국어](#한국어) · [English](#english) · [다운로드 · Download](https://github.com/AI-Inspact-Lab/penmit-pdf/releases) · [웹에서 열기 · Open in the browser](https://ai-inspact-lab.github.io/penmit-pdf/)

---

## 한국어

### 왜 만들었나

태블릿 필기 앱은 기기마다 따로 놀아요. 아이패드에서 쓴 필기를 갤럭시탭이나 윈도우에서 이어서 보려면 유료 클라우드에 가입해야 하는 경우가 많아요. 팬밋 PDF는 **서버가 없어요.** 필기는 각자의 구글 드라이브나 GitHub 저장소에 저장되니 운영 비용이 들지 않고, 데이터는 온전히 내 것이에요.

### 핵심 기능

1. **PDF 보기:** 한쪽 보기, 두쪽 보기, 표지 따로 두쪽 보기. 확대·축소와 두 손가락 핀치를 지원해요.
2. **필기:** 펜, 형광펜, 지우개를 쓸 수 있어요. 애플펜슬, 갤럭시 S펜, 서피스펜, 와콤처럼 브라우저가 인식하는 펜이면 필압까지 받아요. 펜으로 쓰는 동안 손바닥 터치는 무시해요.
3. **동기화:** 내 구글 드라이브나 GitHub 비공개 저장소에 PDF와 필기를 올리고, 다른 기기에서 받아요. 두 기기에서 따로 쓴 필기도 자동으로 합쳐요.

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

### 저장 위치 고르기

**설정(톱니바퀴) → 동기화**에서 고르세요. 기기마다 같은 곳을 고르면 서로 이어져요.

| 저장 위치 | 이런 분께 | 준비물 |
| --- | --- | --- |
| **구글 드라이브** | 대부분의 사람 | 구글 계정 (로그인만 하면 끝) |
| **GitHub** | 개발자, 변경 이력까지 남기고 싶은 사람 | GitHub 계정, 비공개 저장소, 토큰 |
| 이 기기에만 | 한 기기에서만 쓰는 사람 | 없음 |

### 구글 드라이브 (가장 쉬워요)

1. **설정 → 동기화 → 구글 드라이브**를 고르고 **구글 계정으로 로그인**을 눌러요.
2. 구글 화면에서 계정을 고르고 허용하면 끝이에요. **저장**을 누르고 **동기화**하세요.
3. 다른 기기에서도 같은 계정으로 로그인하면 돼요.

- 내 드라이브에 `Penmit PDF` 폴더가 생기고 그 안에 저장돼요.
- 앱은 **자기가 만든 파일만** 볼 수 있어요(`drive.file` 권한). 드라이브의 다른 파일은 볼 수 없어요.
- 앱에서 PDF를 지우면 드라이브에서는 **휴지통**으로 가요. 실수로 지워도 30일 안에 되살릴 수 있어요.
- 웹앱은 보안상 한 시간쯤 지나면 다시 로그인하라고 할 수 있어요. 윈도우·리눅스 앱은 로그인을 기억해요.
- **안드로이드 앱은 아직 구글 드라이브를 지원하지 않아요.** 그동안은 GitHub을 쓰거나, 크롬에서 웹앱을 열어 구글 드라이브를 쓰세요.

### GitHub (개발자용)

1. GitHub에서 **비공개(Private)** 저장소를 하나 만들어요. 예: `penmit-notes`
2. [Fine-grained 토큰](https://github.com/settings/personal-access-tokens/new)을 만들어요.
   - Repository access: **Only select repositories** → 방금 만든 저장소
   - Permissions → Repository permissions → **Contents: Read and write**
3. 팬밋 PDF의 **설정 → 동기화 → GitHub**을 고르고 소유자(내 GitHub 아이디), 저장소 이름, 토큰을 넣은 뒤 **연결 확인** → **저장**
4. **동기화**를 누르면 끝이에요. 다른 기기에서도 같은 저장소와 토큰을 넣으면 돼요.

### 어떻게 저장되나

구글 드라이브는 `Penmit PDF/` 폴더 아래, GitHub은 `penmit/` 폴더 아래에 같은 모양으로 저장돼요.

```
<PDF의 SHA-256>/document.pdf   원본 PDF (한 번만 올림)
<PDF의 SHA-256>/meta.json      파일 이름, 쪽수
<PDF의 SHA-256>/ink.json       필기 (작은 텍스트 파일)
```

필기는 원본 PDF와 따로 저장해서, 필기할 때마다 큰 PDF를 다시 올리지 않아요. 문서를 닫을 때 바뀐 게 있으면 자동으로 동기화해요.

### 쓰는 법

- **펜:** 펜으로 바로 필기하고, 손가락으로는 화면을 움직여요. 펜을 한 번도 쓰지 않은 기기(휴대폰 등)에서는 손가락으로 바로 써지고, 두 손가락으로 화면을 넘겨요. 펜을 쓰면 손가락은 화면 넘기기 전용으로 자동으로 바뀌어요(설정 → **손가락으로 필기**에서 바꿀 수 있어요). 그때는 두 손가락으로 움직이고 확대해요.
- **보기·확대:** 오른쪽 위 책 모양 버튼에서 한 쪽/두 쪽/표지 + 두 쪽 보기와 확대 비율을 고를 수 있어요. 두 손가락 핀치, Ctrl + 마우스 휠도 돼요.
- **전체 화면:** 오른쪽 위 네모 모서리 버튼(또는 F 키)을 누르면 위아래 막대가 사라지고, 한 화면에 한 장(두 쪽 보기면 두 쪽)이 꽉 차게 보여요. 손가락으로 옆으로 밀거나 화면 양쪽 끝을 톡 치면 넘어가고(키보드는 ←/→), 펜으로는 그대로 필기돼요.
- **쪽 이동:** 아래 가운데 쪽 번호(예: 3 / 12)를 누르고 쪽 번호를 넣으면 바로 가요. 아이패드는 애플펜슬로 숫자를 손글씨로 써도 돼요.
- **문서 관리:** 문서 이름 옆 ⌄ 버튼(또는 오른쪽 클릭)으로 이름 바꾸기, 필기 포함 PDF 저장, 삭제를 할 수 있어요.
- **단축키:** P 펜, H 형광펜, E 지우개, V 손, Ctrl+Z 실행 취소, Ctrl+Shift+Z 또는 Ctrl+Y 다시 실행

### 개인정보

- 서버가 없어요. PDF와 필기는 기기 안(IndexedDB)과 내가 고른 구글 드라이브나 GitHub 저장소에만 있어요. 개발자는 아무것도 받지 않아요.
- 로그인 정보와 토큰은 그 기기에만 보관돼요. 공용 컴퓨터에서는 쓰지 마세요.
- GitHub 토큰은 저장소 하나, Contents 권한 하나만 주세요. 유출되더라도 그 저장소 밖으로는 영향이 없어요.
- 자세한 내용: [개인정보처리방침](https://ai-inspact-lab.github.io/penmit-pdf/privacy.html)

### 베타 안내 (0.4.0)

- 안드로이드 앱에서는 아직 구글 드라이브를 쓸 수 없어요.
- 암호가 걸린 PDF는 아직 열 수 없어요.
- 내보낸 PDF를 다시 열면 필기가 보이기는 하지만, 지우거나 고칠 수는 없어요.
- 글자 입력, 도형, 페이지 추가는 아직 없어요.

---

## English

### Why

Handwriting apps keep your notes inside their own cloud. Penmit PDF has **no server**: your PDFs and notes live on your devices and in your own Google Drive or GitHub repository, so it costs nothing to run and the data stays yours.

### Features

1. **Read PDFs:** single page, two pages, or cover plus two pages; zoom and two-finger pinch.
2. **Handwrite:** pen, highlighter and eraser, with pressure from Apple Pencil, Galaxy S Pen, Surface Pen, Wacom and any other pen the browser sees. Palm touches are ignored while the pen writes.
3. **Sync:** PDFs and notes go to your Google Drive or a private GitHub repository and come back on your other devices. Notes written on two devices at once are merged.

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

### Choose where to sync

Pick one in **Settings (gear) → Sync**, and pick the same one on each device.

- **Google Drive** (easiest): choose **Sign in with Google**, allow access, **Save**, then **Sync**. Sign in with the same account on your other devices. Files go into a `Penmit PDF` folder in your Drive. The app asks only for the `drive.file` permission, so it sees nothing but the files it created. PDFs deleted in the app go to Drive's bin. The web app may ask you to sign in again after about an hour; the Windows and Linux apps remember the sign-in. **The Android app doesn't support Google Drive yet**: use GitHub there, or the web app in Chrome.
- **GitHub** (for developers):
  1. Create a **private** repository, e.g. `penmit-notes`.
  2. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with access to **only that repository** and **Contents: Read and write**.
  3. In **Settings → Sync**, choose **GitHub**, enter the owner, repository and token, choose **Test connection**, then **Save**.
  4. Press **Sync**. Use the same repository and token on your other devices.
- **This device only**: no sync.

Each PDF is stored as `<sha256>/document.pdf` (uploaded once), `meta.json` and `ink.json` (the notes, as small text), under `Penmit PDF/` in Drive or `penmit/` in the repository. Closing a document syncs it if anything changed.

### Privacy

No server is involved, and the developer receives nothing. Data stays in the device's IndexedDB and in the Google Drive or repository you chose. Sign-in data and tokens are kept only on that device, so don't use them on a shared computer, and limit a GitHub token to one repository with Contents permission. See the [privacy policy](https://ai-inspact-lab.github.io/penmit-pdf/privacy.html).

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

### Google sign-in

Google Drive sync uses two OAuth clients from the project's Google Cloud console, both limited to the `drive.file` scope.

- **Web** (`web/src/config.js`): a public client ID, which Google accepts only from the authorised origins set in the console. Forks need their own client ID.
- **Desktop** (Windows, Linux): an installed-app client used with the system browser, a loopback redirect and PKCE. Its ID and secret are **never committed**. The release workflow writes them into `desktop/google-oauth.json` from the repository secrets `GOOGLE_DESKTOP_CLIENT_ID` and `GOOGLE_DESKTOP_CLIENT_SECRET`; builds without them simply hide Google Drive. For local runs, create that file yourself (it is git-ignored): `{"client_id": "...", "client_secret": "..."}`.
- **Android**: Google doesn't allow sign-in inside app web views, so this needs a native sign-in (planned).

## License

See [LICENSE](LICENSE). Bundled third-party software keeps its own license: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
