<div align="center">

# agy-cli-usage

[![npm version](https://img.shields.io/npm/v/agy-cli-usage?color=cb3837&logo=npm)](https://www.npmjs.com/package/agy-cli-usage)
[![npm downloads](https://img.shields.io/npm/dm/agy-cli-usage?color=cb3837&logo=npm)](https://www.npmjs.com/package/agy-cli-usage)
[![CI](https://github.com/abruption/agy-cli-usage/actions/workflows/ci.yml/badge.svg)](https://github.com/abruption/agy-cli-usage/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![node](https://img.shields.io/node/v/agy-cli-usage?color=339933&logo=node.js)](https://www.npmjs.com/package/agy-cli-usage)
[![license](https://img.shields.io/npm/l/agy-cli-usage?color=blue)](LICENSE)

**Headless usage & quota monitor for the Antigravity CLI (`agy`).**

`agy`의 `/usage` 패널(모델 그룹별 주간·5시간 한도, 잔여율, 리프레시 시각)을 **헤드리스로** 조회합니다 — IDE 불필요, macOS · Linux · Windows · 헤드리스 서버 지원.

<sub>Inspired by <a href="https://github.com/skainguyen1412/antigravity-usage">skainguyen1412/antigravity-usage</a> — which targets the Antigravity <b>IDE</b>; this targets the <b>CLI</b> (<code>agy</code>).</sub>

</div>

---

```text
  Models & Quota
  Account: you@gmail.com

  GEMINI MODELS
    Weekly Limit
    [██████████████████████████████████████████████░░░░] 91.72%
    92% remaining · Refreshes in 73h 23m
    Five Hour Limit
    [███████████████████████████████████████████████░░░] 94.63%
    95% remaining · Refreshes in 2h 2m

  CLAUDE AND GPT MODELS
    Weekly Limit
    [█████████████████████████████████████████████████░] 97.78%
    98% remaining · Refreshes in 26h 17m
    Five Hour Limit
    [██████████████████████████████████████████████████] Quota available
```

## 🚀 빠른 시작

```bash
# 설치 없이 한 번 실행
npx agy-cli-usage

# 전역 설치 → 어디서나 `agy-cli-usage`
npm install -g agy-cli-usage
agy-cli-usage
```

> 사전 조건: 같은 머신에서 `agy`에 로그인되어 있을 것. Node.js >= 18.

## ⚡ 사용법

```bash
agy-cli-usage                  # /usage 와 동일한 패널 (1회성)
agy-cli-usage --json           # 머신 리더블 JSON
agy-cli-usage --watch 60       # 60초 간격 자동 갱신 (5분 캐시 경유)
agy-cli-usage update [--check] # 자기 업데이트 (--check: 알림만)
agy-cli-usage --version        # 버전 출력
```

| 플래그 | 설명 |
|--------|------|
| `--json` | 정규화 JSON 출력 (스크립트/대시보드 연동) |
| `--watch [초]` | N초 간격 갱신 (기본 60) |
| `--source <auto\|api\|pty>` | 데이터 소스 (기본 `auto`: API → 실패 시 PTY) |
| `--channel <auto\|daily\|prod>` | Cloud Code 호스트 |
| `--no-cache` / `--refresh` | 5분 캐시 무시하고 강제 조회 |

## 🤔 왜 필요한가

`agy -p "<prompt>"`(headless)는 LLM 프롬프트 전용이라 `/usage` 같은 TUI 슬래시 커맨드를 렌더링하지 않습니다. 그래서 사용량을 자동화·폴링할 수 없습니다. 이 도구는 그 공백을 메웁니다.

## 🔍 동작 방식

1. **직접 API (기본 · 빠름)** — OS에서 `agy`의 OAuth 토큰을 읽어, `agy`가 시작 시 호출하는 것과 동일한 Cloud Code 내부 API를 직접 호출합니다.
   - `POST /v1internal:loadCodeAssist` → `cloudaicompanionProject` 획득
   - `POST /v1internal:retrieveUserQuotaSummary {project}` → 쿼타
   - 만료 시 OAuth refresh 자동 처리.
2. **PTY 폴백 (안전망)** — 위 토큰을 못 읽거나 내부 API가 바뀌면, `agy`를 가상 터미널로 띄워 `/usage`를 보내고 `@xterm/headless`로 화면을 재구성해 파싱합니다.

## 🔐 크로스플랫폼 자격증명

토큰은 `agy`가 저장한 위치에서 **읽기만** 합니다. 플랫폼별로 자동 처리:

| OS / 환경 | 저장 위치 | 읽는 방법 |
|-----------|----------|----------|
| macOS | Keychain | `@napi-rs/keyring` (폴백 `security`) |
| Linux 데스크톱 | Secret Service | `@napi-rs/keyring` (폴백 `secret-tool`) |
| **Windows** | Credential Manager | 내장 `powershell.exe`로 Win32 `CredRead` 호출 |
| **헤드리스 Linux** | 토큰 파일 | `~/.gemini/antigravity-cli/antigravity-oauth-token` |

읽기 체인: `키링 → OS CLI → Windows credman → 토큰 파일 → PTY`. `AGY_OAUTH_TOKEN_FILE`로 파일 경로 override.

## 🔌 HTTP 엔드포인트 (선택)

```bash
PORT=3007 npm run serve      # GET /quota → 정규화 JSON (5분 캐시), GET /healthz
```

외부 대시보드/스크립트에서 `GET /quota`로 소비하거나 `agy-cli-usage --json`을 subprocess로 호출하세요.

## 🛠️ 개발 / 릴리스

TypeScript(strict, ESM)로 작성하고 `tsc`로 `dist/`에 컴파일합니다.

```bash
npm run build     # tsc → dist/ (컴파일된 JS + .d.ts)
npm run check     # tsc --noEmit (타입 체크)
npm test          # 빌드 후 node --test (자격증명·네트워크 불필요, 순수 로직)
```

- **CI**: push/PR마다 ubuntu(Node 18/20/22) + macOS/Windows(Node 22)에서 테스트.
- **Release**: [release-please](https://github.com/googleapis/release-please) — Conventional Commits 기반 완전 자동화. main에 머지된 커밋으로 release-please가 **Release PR**(버전 범프 + CHANGELOG)을 유지하고, 그 PR을 머지하면 태그·GitHub Release·`npm publish --provenance`가 자동 실행됩니다.

## ⚠️ 주의

- `v1internal:retrieveUserQuotaSummary`는 **비공개 내부 엔드포인트**입니다. 스키마/호스트가 예고 없이 바뀔 수 있으며, 그때의 안전망이 PTY 폴백입니다. 본인 계정의 사용량 조회 용도로만 사용하세요.
- 자격증명은 OS 저장소에서 **읽기만** 하며, refresh 토큰을 되쓰지 않아 `agy` 세션과 충돌하지 않습니다.
- 코드에 포함된 OAuth client_id/secret은 `agy` 바이너리에 들어 있는 **installed-app(public) 값**으로, [Google 문서](https://developers.google.com/identity/protocols/oauth2)상 기밀이 아닙니다. 사용자 식별은 각자의 키링 토큰으로 이뤄집니다.

## 📄 License

[MIT](LICENSE) © abruption
