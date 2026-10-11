# statusline

Claude Code 입력창 위에 두 줄짜리 상태 밴드를 그리는 mod입니다.

```
🧩 Opus 5.5 🎚️high 💭thinking 🏎️fast off │ ⏵⏵ bypass permissions on │ 🟡 dirty !2 │ no env │ 🗂️ ~/project/idea 🔀(main) │ 💵 1.50$ │ ⏱️ 12m
📚 Context ████░░░░ 12% (24k/200k) │ 🔋 5H ████░░░░ 42% ↻2h15m │ 📅 7D █░░░░░░░ 7% ↻Oct 14 2pm
```

## 표시 항목

| 항목 | 뜻 | 클릭하면 |
|---|---|---|
| `🧩 Opus 5.5` | 현재 모델 | 그 자리에 모델 선택창 → `/model <별칭>` |
| `🎚️high` | effort 레벨 | 그 자리에 effort 선택창 → `/effort <레벨>` |
| `💭thinking` | thinking 켜짐 (꺼지면 흐린 `💭thinking off`) | `/config`의 thinking 토글 |
| `🏎️fast off` | fast 모드 (켜지면 `🏎️fast`) | `/fast` 대화상자 |
| `⏵⏵ … on` | 현재 permission mode | 표시만 함 (전환은 shift+tab) |
| `🟢 git clean` / `🟡 dirty +S!U?N` | git 상태: `+` stage, `!` 수정, `?` 미추적, `↑↓` 원격 대비 | – |
| `🧪 env` | conda 환경 (`CONDA_DEFAULT_ENV`) | – |
| `🗂️ 경로 🔀(브랜치)` | 세션 디렉터리와 브랜치 | – |
| `💵` / `⏱️` | 세션 비용 / 경과 시간 | – |
| `📚` `🔋` `📅` 바 | 컨텍스트 사용량, 5시간·7일 사용 한도와 리셋 시각 | – |

선택창은 고르면 적용되고 닫히며, `✕`로 그냥 닫을 수 있습니다.
전체화면 터미널에서는 클릭으로, 그 외에는 ctrl+x tab으로 밴드에 포커스를 준 뒤 Tab/Enter로 조작합니다.
밴드는 `[-]` 또는 ctrl+x ctrl+a로 접을 수 있습니다.

## 설치

Claude Code 프롬프트에서:

```
/plugin install statusline --marketplace jjaktoung/claude-status-mod
```

저장소를 클론한 로컬 폴더에서 설치하려면:

```
/plugin install statusline --marketplace /path/to/claude-status-mod
```

`Add marketplace?`에 `y`, 범위는 user를 고르면 이후 모든 세션에서 로드됩니다.

## 알려진 제한

- 현재 세션의 permission mode는 mod API로 바꿀 수 없어 표시만 합니다.
- thinking을 끌 수 없는 모델(예: Opus 5.5)에서 `💭thinking`을 누르면 Claude Code가 거절하고 그 이유가 알림으로 표시됩니다.
- `/model`, `/effort`는 기본값(새 세션)도 함께 저장합니다.

## 개발

```
claude plugin validate .
claude plugin test .
```

타입 체크는 mod가 한 번 로드되어 `.claude-plugin/types/`가 생긴 뒤 `tsc -p .`로 합니다.
