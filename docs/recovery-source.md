# Restoring release sources

Use a fresh checkout of the release ref and the pinned package manager. A deployment can include a private source overlay. Restore the matching patch and manifest from the operator’s encrypted backup into a private recovery workspace. Check the patch SHA-256, run `git apply --check` and apply it there. Verify the resulting source hashes against the private manifest before compiling.

Install dependencies from the frozen lockfile. Run the TypeScript build in an isolated environment and compare each output SHA-256 with the release manifest. The active provider executable has a separate version and digest in that manifest. Restore the corresponding executable and verify it before starting the application. Account profiles, credentials and state come from the encrypted runtime backup.

The November 2026 recovery check used Node 24.18.0 and TypeScript 5.9.3. Applying the private overlay to a clean checkout reproduced all 48 expected JavaScript files byte for byte. A historical file remained in the original distribution outside the clean compiler output. The private inventory records it separately for disk-image recovery.
