# Quality & Maintainability Controls (ISO/IEC 5055-aligned)

This project applies practical controls aligned with ISO/IEC 5055 quality dimensions:

- **Reliability**
  - reconnect backoff lifecycle
  - safe-stop on fatal movement/inventory errors
  - checkpoint resume for interrupted runs
- **Security / Robustness**
  - strict config parsing + bounded validation
  - chunk-load checks before critical actions
  - bounded retries/cooldowns for refill and teleport workflows
- **Performance Efficiency**
  - opportunistic nearby refill (no long travel pathing)
  - lag-aware placement throttling
  - ignored-container cache with pruning
- **Maintainability**
  - duplicate-function guard (`npm run check` includes structure check)
  - explicit helper boundaries for movement/refill/checkpoint logic

## Local quality gate

```bash
npm run check
```

This runs:
1. JavaScript syntax check
2. duplicate function declaration structure check
