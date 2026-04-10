# Avatar Retail Example

Runnable example showing the same `AvatarAgent` with two renderer shapes and
the built-in `retailProfessionalAvatarProfile`:

- in-store kiosk renderer
- web avatar renderer

Both renderers use `MockAvatarRenderer` so the example runs in CI and local
development without AIRI. In a visual deployment, swap the renderer for
`AIRIRenderer` or a browser-specific adapter.

The retail profile is intentionally less cute and more professional: it uses
subtle motion, sober expressions, small nods, open-palm presentation gestures,
queue acknowledgement, and confirmation gestures. The renderer still stays
pure; it only renders commands and never changes the text or agent decision.

## Run

```bash
pnpm --filter fitalyagents build
pnpm --filter avatar-retail-example run run
```

## What It Shows

- `TARGET_GROUP_CHANGED` makes the avatar look at the active customer
- the professional profile adds subtle gestures such as `small_nod` and
  `acknowledge_queue`
- `TASK_AVAILABLE` moves the avatar into `thinking`
- `RESPONSE_START` and `AVATAR_SPEAK` move the avatar into `speaking`
- `RESPONSE_END` returns the avatar to the target-aware resting state
- `DRAFT_CREATED` and `APPROVAL_RESOLVED` trigger confirmation and approval expressions
