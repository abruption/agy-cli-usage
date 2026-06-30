<div align="center">

# agy-cli-usage

[![npm version](https://img.shields.io/npm/v/agy-cli-usage?color=cb3837&logo=npm)](https://www.npmjs.com/package/agy-cli-usage)
[![npm downloads](https://img.shields.io/npm/dm/agy-cli-usage?color=cb3837&logo=npm)](https://www.npmjs.com/package/agy-cli-usage)
[![CI](https://github.com/abruption/agy-cli-usage/actions/workflows/ci.yml/badge.svg)](https://github.com/abruption/agy-cli-usage/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![node](https://img.shields.io/node/v/agy-cli-usage?color=339933&logo=node.js)](https://www.npmjs.com/package/agy-cli-usage)
[![license](https://img.shields.io/npm/l/agy-cli-usage?color=blue)](LICENSE)

**Antigravity CLI(`agy`) 사용량·쿼타 모니터 (headless).**

`agy`의 `/usage` 패널 — 모델 그룹별 주간·5시간 한도, 잔여율, 리프레시 시각 — 을 **헤드리스로** 조회합니다. IDE 불필요, macOS · Linux · Windows · 헤드리스 서버 지원.

[English](README.md) · **한국어**

<sub><a href="https://github.com/skainguyen1412/antigravity-usage">skainguyen1412/antigravity-usage</a>에서 영감 — 그쪽은 Antigravity <b>IDE</b> 대상, 이 프로젝트는 <b>CLI</b>(<code>agy</code>) 대상입니다.</sub>

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

---

# 사람을 위한 안내 (For Human)

## 개요

`agy-cli-usage`는 `agy`의 인터랙티브 `/usage` 슬래시 커맨드와 동일한 사용량·쿼타 정보를 일반 셸에서 보여줍니다 — 1회성, watch 모드, 또는 머신 리더블 JSON. 잔여 쿼타 확인, 상태바 연동, 대시보드 공급 등에 사용하세요.

## 왜 필요한가

`agy -p "<prompt>"`(헤드리스 모드)는 LLM 프롬프트 전용 경로라 `/usage` 같은 TUI 슬래시 커맨드를 렌더링하지 않습니다. 그래서 사용량을 자동화·폴링할 수 없습니다. 이 도구는 쿼타를 직접 읽어(필요 시 `agy`를 가상 터미널로 구동해) 그 공백을 메웁니다.

## 빠른 시작

```bash
# 설치 없이 한 번 실행
npx agy-cli-usage

# 전역 설치 → 어디서나 `agy-cli-usage` (별칭 `agy-usage`)
npm install -g agy-cli-usage
agy-cli-usage
```

> 사전 조건: 같은 머신에서 `agy`에 로그인되어 있을 것, Node.js >= 18.

## 사용법

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
| `-h`, `--help` | 도움말 |
| `-v`, `--version` | 버전 |

## 동작 방식

1. **직접 API (기본 · 빠름).** OS에서 `agy`의 OAuth 토큰을 읽어, `agy`가 시작 시 호출하는 것과 동일한 Cloud Code 내부 API를 직접 호출합니다.
   - `POST /v1internal:loadCodeAssist` → `cloudaicompanionProject` 획득
   - `POST /v1internal:retrieveUserQuotaSummary {project}` → 쿼타
   - 만료 시 OAuth refresh 자동 처리.
2. **PTY 폴백 (안전망).** 토큰을 못 읽거나 내부 API가 바뀌면, `agy`를 가상 터미널로 띄워 `/usage`를 보내고 `@xterm/headless`로 화면을 재구성해 파싱합니다.

## 크로스플랫폼 자격증명

토큰은 `agy`가 저장한 위치에서 **읽기만** 합니다. 플랫폼별 자동 처리:

| OS / 환경 | 저장 위치 | 읽는 방법 |
|-----------|----------|----------|
| macOS | Keychain | `@napi-rs/keyring` (폴백 `security`) |
| Linux 데스크톱 | Secret Service | `@napi-rs/keyring` (폴백 `secret-tool`) |
| **Windows** | Credential Manager | 내장 `powershell.exe`로 Win32 `CredRead` 호출 |
| **헤드리스 Linux** | 토큰 파일 | `~/.gemini/antigravity-cli/antigravity-oauth-token` |

읽기 순서: `키링 → OS CLI → Windows credman → 토큰 파일 → PTY`. 파일 경로는 `AGY_OAUTH_TOKEN_FILE`로 override.

## HTTP 엔드포인트 (선택)

```bash
PORT=3007 npm run serve      # GET /quota → 정규화 JSON (5분 캐시), GET /healthz
```

외부 대시보드/스크립트에서 `GET /quota`로 소비하거나, `agy-cli-usage --json`을 서브프로세스로 호출하세요.

## 개발 & 릴리스

TypeScript(strict, ESM)로 작성하고 `tsc`로 `dist/`에 컴파일합니다.

```bash
npm run build     # tsc → dist/ (컴파일된 JS + .d.ts)
npm run check     # tsc --noEmit (타입 체크)
npm test          # 빌드 후 node --test (자격증명·네트워크 불필요, 순수 로직)
```

- **CI**: push/PR마다 Ubuntu(Node 18/20/22) + macOS/Windows(Node 22)에서 테스트.
- **릴리스**: [release-please](https://github.com/googleapis/release-please) — Conventional Commits 기반 완전 자동화. main에 머지된 커밋으로 **Release PR**(버전 범프 + CHANGELOG)이 유지되고, 그 PR을 머지하면 태그·GitHub Release·`npm publish --provenance`가 자동 실행됩니다.

## 주의

- `v1internal:retrieveUserQuotaSummary`는 **비공개·비문서 내부 엔드포인트**입니다. 스키마/호스트가 예고 없이 바뀔 수 있으며, 그때의 안전망이 PTY 폴백입니다. 본인 계정의 사용량 조회 용도로만 사용하세요.
- 자격증명은 OS 저장소에서 **읽기만** 하며, refresh 토큰을 되쓰지 않아 `agy` 세션과 충돌하지 않습니다.
- 코드에 포함된 OAuth client_id/secret은 `agy` 바이너리의 **installed-app(public)** 값으로, [Google 문서](https://developers.google.com/identity/protocols/oauth2)상 기밀이 아닙니다. 사용자 식별은 각자의 키링 토큰으로 이뤄집니다.

## 라이선스

[MIT](LICENSE) © abruption

---

# 에이전트(AI)를 위한 안내 (For Agent)

> 프로그래밍적 사용을 위한 머신 지향 스펙. 안정적 계약: `--json` 스냅샷과 `GET /quota` 페이로드는 동일한 형태(`Snapshot`)를 공유합니다.

## TL;DR

- 바이너리: `agy-cli-usage` (별칭 `agy-usage`). Node >= 18. 같은 호스트에 `agy` 로그인 필요.
- 구조화 데이터: `agy-cli-usage --json` (stdout) 또는 `GET http://127.0.0.1:3007/quota`.
- `auto`의 소스 순서: 직접 API → PTY 폴백. 결과는 5분 캐시.

## 커맨드

| 호출 | 동작 |
|------|------|
| `agy-cli-usage` | 패널을 stdout에 렌더(휴먼 포맷). |
| `agy-cli-usage --json` | `Snapshot` JSON을 stdout에 출력 후 종료. |
| `agy-cli-usage --watch [초]` | `초`(최소 5, 기본 60)마다 화면 클리어 후 재렌더. 무한 실행. |
| `agy-cli-usage --source <auto\|api\|pty>` | `api`: API 전용(실패 시 throw). `pty`: PTY 전용(캐시 무시). `auto`: API→PTY. |
| `agy-cli-usage --channel <auto\|daily\|prod>` | Cloud Code 호스트 선택. `auto`는 `daily`→`prod` 순서. |
| `agy-cli-usage --no-cache` / `--refresh` | 강제 신규 조회(5분 캐시 스킵). |
| `agy-cli-usage update [--check]` | `npm i -g` 자가 업데이트. `--check`는 알림만. |
| `agy-cli-usage --version` / `-v` | 버전 문자열을 stdout에 출력. |

## JSON 출력 (`--json`) — 스키마

```jsonc
{
  "account": "you@gmail.com | null",
  "tier": "string | null",
  "fetchedAt": "ISO-8601 타임스탬프",
  "source": "api | pty",
  "host": "cloud code host | null",
  "note": "string | null",
  "groups": [
    {
      "name": "GEMINI MODELS",
      "models": "쉼표 구분 모델 목록 (빈 문자열 가능)",
      "buckets": [
        {
          "kind": "weekly | 5h | <기타>",
          "label": "Weekly Limit",
          "remainingFraction": 0.9172,        // 0..1, 미상이면 null
          "usedFraction": 0.0828,             // 1 - remainingFraction, 또는 null
          "resetAt": "ISO-8601 | null",
          "resetsInSeconds": 264180,          // 정수 초, 또는 null
          "available": false,                 // remainingFraction === 1 이면 true
          "description": "string | null"
        }
      ]
    }
  ]
}
```

파싱 시 참고:
- `remainingFraction`(잔여 비율 0–1)을 우선 사용. `available`이 `true`면 풀 쿼타로 간주(패널은 "Quota available" 표시).
- `resetsInSeconds`는 `fetchedAt` 기준 상대값, `resetAt`은 절대값. 둘 다 `null` 가능.
- `kind`는 인식 시 `weekly`/`5h`로 정규화, 아니면 원본 window/label 문자열.

## HTTP API (`npm run serve` / `dist/src/server.js`)

| 라우트 | 응답 |
|--------|------|
| `GET /quota` | `200` `Snapshot` JSON(`--json`과 동일 형태). `?refresh=1`은 캐시 우회. 실패 시 `502 {"error":...}`. 헤더: `Cache-Control: public, max-age=300`, `Access-Control-Allow-Origin: *`. |
| `GET /healthz` | `200 {"ok":true}` |
| (그 외) | `404 {"error":"not found"}` |

`HOST`(기본 `127.0.0.1`) : `PORT`(기본 `3007`)에 바인딩.

## 환경변수

| 변수 | 효과 |
|------|------|
| `AGY_OAUTH_TOKEN_FILE` | 토큰 파일 경로 override(헤드리스 폴백). |
| `AGY_BIN` | `agy` 바이너리 경로(PTY 소스). 없으면 `PATH`→`~/.local/bin` 순 탐색. |
| `XDG_CACHE_HOME` | 캐시 베이스 디렉토리(캐시는 `<base>/agy-usage/quota.json`, 기본 `~/.cache`). |
| `NO_COLOR` | 렌더 패널의 ANSI 색상 비활성화. |
| `PORT` / `HOST` | HTTP 서버 바인딩(서버 모드 한정). |

## 종료 코드 & 오류

- `0` — 성공.
- `1` — 모든 오류(예: 토큰을 못 읽고 PTY도 불가할 때 `CredentialError`). 오류 텍스트는 **stderr**로, 구조화 출력은 **stdout**으로 나가므로, stderr에 경고(`auto` 모드의 `[api failed: …] falling back to PTY` 알림 등)가 있어도 `--json` stdout은 안전하게 파싱 가능.
- `update`는 내부 `npm` 종료 코드를 반환.

## 데이터 소스 & 캐시

- **캐시**: `<XDG_CACHE_HOME|~/.cache>/agy-usage/quota.json`, TTL **5분**. `--watch`/폴링 시 업스트림 API 부하 회피. `source === 'pty'`이거나 캐시 비활성(`--no-cache`/`--refresh`, HTTP 라우트의 `?refresh=1`) 시 우회.
- **API 경로**는 토큰(키링/파일)을 읽어 `loadCodeAssist` → `retrieveUserQuotaSummary` 호출. **PTY 경로**는 `agy`를 구동(POSIX `python3 pty`, Windows `node-pty`)하며 환경에서 `agy` 실행 가능해야 함.

## 연동 노트

- 자동화 시 `--json`(서브프로세스) 또는 `GET /quota`(상시 서비스)를 호출. 둘 다 동일 캐시를 거치므로 고빈도 폴링도 안전.
- 휴먼 패널은 파싱하지 말 것 — ANSI 이스케이프 포함, 레이아웃 지향. `Snapshot` JSON이 안정적 계약.
- 이 도구는 자격증명을 **읽기만** 하며, `agy` 세션을 변경하거나 토큰을 되쓰지 않음.
