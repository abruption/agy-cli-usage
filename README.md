# agy-cli-usage

[![CI](https://github.com/abruption/agy-cli-usage/actions/workflows/ci.yml/badge.svg)](https://github.com/abruption/agy-cli-usage/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agy-cli-usage.svg)](https://www.npmjs.com/package/agy-cli-usage)

Headless usage/quota monitor for the Antigravity CLI (`agy`). `agy`의 인터랙티브 `/usage` 패널과 동일한 정보(모델 그룹별 주간·5시간 한도, 잔여율, 리프레시 시각)를 **headless로** 조회한다. IDE 불필요.

`agy -p "<prompt>"`(headless)는 `/usage` 같은 TUI 슬래시 커맨드를 렌더링하지 않으므로 자동화가 불가능하다. 이 도구는 `agy`가 내부적으로 호출하는 Cloud Code API를 직접 호출하거나, 불가능할 때 `agy`를 PTY로 구동해 패널을 파싱한다.

## 설치

```bash
# npm 레지스트리에서
npm install -g agy-cli-usage

# 또는 GitHub에서 직접
npm install -g github:abruption/agy-cli-usage
npx github:abruption/agy-cli-usage

# 또는 소스에서
git clone https://github.com/abruption/agy-cli-usage && cd agy-cli-usage
npm install && npm link
```

전역 명령은 `agy-cli-usage` (별칭 `agy-usage`)로 등록된다. Node.js >= 18 (전역 `fetch` 필요). 사전 조건: 같은 머신에서 `agy`에 로그인되어 있을 것.

## 사용법

```bash
agy-usage                  # /usage 와 동일한 패널 출력 (1회성)
agy-usage --json           # 머신 리더블 JSON
agy-usage --watch 60       # 60초 간격 자동 갱신 (5분 캐시 경유)
agy-usage --source api|pty|auto   # 데이터 소스 (기본 auto: API → 실패 시 PTY)
agy-usage --channel daily|prod    # Cloud Code 호스트 (기본 auto: daily→prod 탐지)
agy-usage --no-cache               # 5분 캐시 무시하고 강제 조회
```

## 동작 방식

`agy`는 OAuth 토큰을 OS 키링(zalando/go-keyring 규약, service=`gemini`/account=`antigravity`)에 저장한다.

1. **직접 API (기본)** — 키링에서 토큰을 읽고(만료 시 자동 refresh), `agy`와 동일하게:
   - `POST https://<host>/v1internal:loadCodeAssist` → `cloudaicompanionProject` 획득
   - `POST https://<host>/v1internal:retrieveUserQuotaSummary {project}` → 쿼타
   - 호스트: `daily-cloudcode-pa.googleapis.com`(현재 CLI) 또는 `cloudcode-pa.googleapis.com`
2. **PTY 폴백** — 키링을 읽을 수 없거나(헤드리스 등) 내부 API가 바뀌면, `agy`를 가상 터미널로 띄워 `/usage`를 보내고, `@xterm/headless`로 alt-screen을 재구성해 패널을 파싱한다.

### 크로스플랫폼 자격증명

| OS | 키링 백엔드 | 비고 |
|----|-----------|------|
| macOS | Keychain | `@napi-rs/keyring`, CLI 폴백 `security` |
| Windows | Credential Manager | `@napi-rs/keyring` |
| Linux (데스크톱) | Secret Service | `@napi-rs/keyring`, CLI 폴백 `secret-tool` |
| Linux (헤드리스) | — | Secret Service 부재 시 `--source pty`로 우회 (python3 필요) |

## HTTP 엔드포인트 (선택)

```bash
PORT=3007 node server.js     # GET /quota → 정규화 JSON (5분 캐시), GET /healthz
```

외부 대시보드/스크립트에서 `GET /quota`로 소비하거나, `agy-usage --json`을 subprocess로 호출한다.

## 개발 / 릴리스

```bash
npm test          # node --test (자격증명·네트워크 불필요, 순수 로직)
npm run check     # 구문 검사
```

- **CI** (`.github/workflows/ci.yml`): push/PR마다 ubuntu(Node 18/20/22) + macOS/Windows(Node 22)에서 테스트.
- **Release** (`.github/workflows/release.yml`): `v*` 태그 push 시 빌드·테스트 후 npm publish(provenance) + GitHub Release 생성. `NPM_TOKEN` 시크릿 필요.

```bash
npm version patch        # package.json 버전 +0.0.1 & v* 태그 생성
git push --follow-tags   # → Release 워크플로 실행 → npm 자동 배포
```

## 주의

- `v1internal:retrieveUserQuotaSummary`는 **비공개 내부 엔드포인트**다. 스키마/호스트가 예고 없이 바뀔 수 있으며, 그때를 위한 안전망이 PTY 폴백이다.
- 본인 계정의 키링 토큰만 읽으며(읽기 전용), refresh 토큰을 키링에 되쓰지 않는다.
- OAuth client_secret은 데스크톱(공개) 클라이언트 값이라 비밀이 아니다.
