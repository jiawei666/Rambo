# Agent Robot Avatar

- Source: https://github.com/CX-ArtLab/agent-robot-avatar
- Commit: e600f7e3b22dd792c3fc7b26994fa6bae39f1e66
- Version: 0.5.2
- License: MIT, copyright 2026 CX ART Lab. See LICENSE.

The entry point and src modules are copied from the commit above, with one Rambo
patch in `src/agent-robot-avatar-core.js`: the generated SVG uses a luminance mask
to cut the animated eye shapes out of the face, so the avatar container's background
shows through. The cutout geometry follows the same eye poses and animation as the
visible eyelid layers. Preserve this patch when updating upstream.

agent-robot-avatar.d.ts is the upstream index.d.ts, renamed for TypeScript's
relative .js module resolution. Rambo's React/lifecycle adapter is outside this
folder, in robot-avatar.tsx. The preview uses this same source via a relative symlink.
