# Deploy hosts and script wiring: research notes

Gathered 2026-09-20 and 2026-09-21 for the [deploy hosts and script wiring spec](../specs/2026-09-21-deploy-hosts-and-script-wiring-design.md). Every claim carries a URL; UNKNOWN marks what could not be verified from vendor docs or source. Part A covers frameworks, part B prior art and portable shells, part C the deploy hosts not already verified in the spec.

---

# Part A: Research A: frameworks, scaffolded scripts, env loading (2026-09-21)

Hook-friendly = values are read through `process.env`. Hook-blind = a private parsed map. L = local-only, H = host-run, LC = lifecycle.

## Next.js (create-next-app)
- Scripts: `dev: next dev`, `build: next build`, `start: next start`, `lint` (https://github.com/vercel/next.js/blob/canary/packages/create-next-app/templates/index.ts). dev/lint L; build/start H.
- `@next/env` `loadEnvConfig` ends with `Object.assign(process.env, parsed)` (https://github.com/vercel/next.js/blob/canary/packages/next-env/index.ts). Called by `next build` (build/index.ts) and by config loading for dev and `next start` (server/config.ts), so `next start` loads `.env.production(.local)`/`.env(.local)` into process.env.
- Turbopack: Rust side does not read .env; JS passes `process.env` into the project (`crates/next-api/src/project.rs` builds EnvMap from it). `getDefineEnv` reads `process.env` via `getNextPublicEnvironmentVariables` (`packages/next/src/lib/static-env.ts`, `build/define-env.ts`). Same for webpack.
- Hook-friendly at dev, build, start. Enumerates all of process.env (`Object.assign({}, process.env)`, `for key in process.env`).
- Public prefix `NEXT_PUBLIC_` (inlined at build). Private values not inlined, but static prerender during `next build` evaluates `process.env.X` and bakes the HTML.

## Vite (create-vite)
- React: `dev: vite`, `build: tsc -b && vite build`, `lint: oxlint`, `preview: vite preview`. Vue: `build: vue-tsc -b && vite build`. Svelte: `build: vite build`, `check: ...` (https://github.com/vitejs/vite/tree/main/packages/create-vite). dev/lint/check L; build/preview H.
- `loadEnv` parses .env files into a map, then copies matching `process.env` keys over it, so process.env wins (https://github.com/vitejs/vite/blob/main/packages/vite/src/node/env.ts lines 28-32, 98-101). Verified hook-friendly by the parent.
- Public prefix `VITE_` (`envPrefix`). `define` entries are statically replaced.

## Nuxt (nuxi init)
- `build: nuxt build`, `dev: nuxt dev`, `generate: nuxt generate`, `preview: nuxt preview`, `postinstall: nuxt prepare` (https://github.com/nuxt/starter/blob/v4/package.json). dev L; build/generate/preview H; postinstall LC.
- c12 `setupDotenv` writes into process.env at dev/build/generate/preview (https://github.com/nuxt/nuxt/blob/main/packages/kit/src/loader/config.ts, https://github.com/unjs/c12/blob/main/src/dotenv.ts). Built server does not read .env; Nitro `applyEnv` reads `process.env.NUXT_*`/`NITRO_*` at runtime (https://github.com/nitrojs/nitro/blob/main/src/runtime/internal/runtime-config.ts).
- Hook-friendly. Public prefix `NUXT_PUBLIC_`. Partial build-time baking: `runtimeConfig` defaults computed in nuxt.config from `process.env.X` are serialized into the Nitro bundle (https://github.com/nuxt/nuxt/blob/main/docs/3.guide/6.going-further/10.runtime-config.md line 78).

## SvelteKit (sv create)
- Verbatim template scripts: UNKNOWN (template not located in sveltejs/cli). create-vite Svelte is the closest sibling.
- Vite plugin: `loadEnv(mode, dir, '')` then `filter_env` (https://github.com/sveltejs/kit/blob/main/packages/kit/src/exports/vite/utils.js). `$env/static/*` emitted as `export const KEY = "<value>"` at build (`packages/kit/src/core/env.js`; https://svelte.dev/docs/kit/$env-static-private). `$env/dynamic/*`: loadEnv values in dev; `process.env` via adapter-node in prod (https://github.com/sveltejs/kit/blob/main/packages/adapter-node/src/handler.js line 37).
- With prefix '' loadEnv copies every process.env key over the file values, so under `kerstel exec` (whose Bun runtime loads the project .env into its own env, inherited by the child) the same mechanism that makes Vite work applies. Not independently verified for SvelteKit.
- Public prefix `PUBLIC_`. **Build-time inlining of private values: yes** (`$env/static/private`).

## Astro (create astro)
- `dev: astro dev`, `build: astro build`, `preview: astro preview`, `astro: astro` (https://github.com/withastro/astro/blob/main/examples/basics/package.json).
- `env-loader.ts` uses Vite loadEnv. `import.meta.env.<PRIVATE>` in server code is esbuild-`define`d at build (https://github.com/withastro/astro/blob/main/packages/astro/src/env/vite-plugin-import-meta-env.ts). `astro:env`: build populates process.env; `access:"secret"` → runtime `process.env[key]` (https://github.com/withastro/astro/blob/main/packages/astro/src/env/vite-plugin-env.ts, runtime.ts); `access:"public"` inlined.
- Public prefix `PUBLIC_`. **Build-time inlining of private values: yes** for `import.meta.env` private and `astro:env` public server vars; no for secrets.

## React Router v7 / Remix (create-react-router)
- `build: react-router build`, `dev: react-router dev`, `start: react-router-serve ./build/server/index.js`, `typecheck` (https://github.com/remix-run/react-router-templates/blob/main/default/package.json).
- `Object.assign(process.env, vite.loadEnv(mode, envDir, ""))` (https://github.com/remix-run/react-router/blob/main/packages/react-router-dev/vite/load-dotenv.ts). `react-router-serve` loads nothing. Hook-friendly. Public prefix `VITE_`. No private inlining.

## TanStack Start
- `dev: vite dev --port 3000`, `generate-routes: tsr generate`, `build: vite build`, `preview: vite preview` (https://github.com/TanStack/create-tsrouter-app/blob/main/packages/create/src/frameworks/react/project/base/package.json); start-basic adds `start: node .output/server/index.mjs`.
- `Object.assign(process.env, loadEnv(...))` (https://github.com/TanStack/router/blob/main/packages/start-plugin-core/src/vite/load-env-plugin/plugin.ts). Hook-friendly. Public `VITE_`/`PUBLIC_`.

## Expo (create-expo-app)
- `start: expo start`, `reset-project`, `android`, `ios`, `web`, `lint` (https://github.com/expo/expo/blob/main/templates/expo-template-default/package.json). All L; no build script.
- `@expo/env` writes unset keys into process.env (https://github.com/expo/expo/blob/main/packages/@expo/env/src/index.ts lines 269-301). Babel inliner reads `process.env.EXPO_PUBLIC_*` (https://github.com/expo/expo/blob/main/packages/babel-preset-expo/src/plugins/inline-env-vars.ts). Hook-friendly. Public `EXPO_PUBLIC_`.

## Angular (ng new)
- `ng`, `start: ng serve`, `build: ng build`, `watch`, `test` (https://github.com/angular/angular-cli/blob/main/packages/schematics/angular/workspace/files/package.json.template). No .env support; `@ngx-env/builder` adds `NG_APP_*`. Note `start` is the dev server here, not a host-run start.

## NestJS (nest new)
- `build: nest build`, `deploy`, `format`, `start: nest start`, `start:dev`, `start:debug`, `start:prod: node dist/main`, `lint`, `test*` (https://github.com/nestjs/typescript-starter/blob/master/package.json).
- `@nestjs/config` writes dotenv keys not already in process.env into process.env; `ignoreEnvVars`, `expandVariables`, `skipProcessEnv`, `cache` (https://github.com/nestjs/config/blob/master/lib/config.module.ts). Hook-friendly. No public prefix, no inlining.

## Express generator
- `start: node ./bin/www` (https://github.com/expressjs/generator/blob/master/bin/express-cli.js). No env loading.

## Hono on Bun (create-hono bun template)
- `dev: bun run --hot src/index.ts` (https://github.com/honojs/starter/blob/main/templates/bun/package.json). Hono `env(c)` on Bun returns `process.env` (https://github.com/honojs/hono/blob/main/src/helper/adapter/index.ts). Bun docs call `Bun.env` an alias of `process.env` (https://github.com/oven-sh/bun/blob/main/docs/runtime/environment-variables.mdx).

## Elysia
- npm `create-elysia` template: `start: bun run main.ts`, `typecheck: tsc` (https://unpkg.com/create-elysia@0.1.0/template-bun/package.json). Docs quick-start: `dev: bun --watch src/index.ts`, `build: bun build src/index.ts --target bun --outdir ./dist`, `start: NODE_ENV=production bun dist/index.js`, `test: bun test` (https://github.com/elysiajs/documentation/blob/main/docs/quick-start.md). Which `bun create elysia` yields today: UNKNOWN. Docs mix `process.env` and `Bun.env`.

## Turborepo root (create-turbo)
- `build/dev/lint/check-types: turbo run ...`, `format: prettier` (https://github.com/vercel/turborepo/blob/main/examples/basic/package.json).
- Strict env mode is the default. Built-in pass-through list includes `NODE_OPTIONS`, `PATH`, `HOME`, `CI`, `NEXT_*`, `VERCEL*`, `GITHUB_*`, `TURBO_*` and more (https://github.com/vercel/turborepo/blob/main/crates/turborepo-env/src/lib.rs lines 22-95). **`KERSTEL_SOCKET`, `KERSTEL_TOKEN_FILE`, `KERSTEL_HOOK_DIR` are NOT in it** and are stripped unless listed in `passThroughEnv`/`globalPassThroughEnv` (https://turborepo.dev/docs/reference/configuration). Framework inference adds `NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*`, `GATSBY_*`, `NUXT_*`, `NUXT_ENV_*`, `EXPO_PUBLIC_*`, `PUBLIC_*`, `REMIX_*`, `REDWOOD_ENV_*`, `SANITY_STUDIO_*` to `env` (https://turborepo.dev/docs/crafting-your-repository/using-environment-variables). Turbo does not load .env files.

## Nx root (create-nx-workspace)
- Empty scripts block (https://github.com/nrwl/nx/blob/master/packages/workspace/src/generators/new/files-package-based-repo/package.json__tmpl__). Nx loads `.env*` into process.env without overwriting; no filtering (https://nx.dev/docs/reference/environment-variables). Public `NX_PUBLIC_`.

## Public prefixes (must stay plaintext)
| Prefix | Framework |
|---|---|
| `NEXT_PUBLIC_` | Next.js |
| `VITE_` | Vite, React Router v7, TanStack Start, SolidStart |
| `PUBLIC_` | SvelteKit, Astro, TanStack Start on Rsbuild |
| `NUXT_PUBLIC_` | Nuxt |
| `EXPO_PUBLIC_` | Expo |
| `REACT_APP_` | Create React App |
| `GATSBY_` | Gatsby |
| `NG_APP_` | Angular via ngx-env |
| `TAURI_ENV_` | Tauri v2 |
| `STORYBOOK_` | Storybook |
| `NX_PUBLIC_` | Nx |
| `REMIX_`, `REDWOOD_ENV_`, `SANITY_STUDIO_`, `NUXT_ENV_` | per Turborepo inference, not independently verified |

## Frameworks whose build embeds non-public values
- SvelteKit `$env/static/private` (verified). Astro `import.meta.env.<PRIVATE>` in server code and `astro:env` public server vars (verified). Nuxt runtimeConfig defaults from process.env (verified, docs). Vite `define` (docs). Next.js static prerender evaluates process.env during build (docs inference).

## Design notes
1. Many loaders enumerate all of process.env eagerly; the proxy's `ownKeys`/descriptor path is already exercised by the verified Vite/`{...process.env}` probes.
2. React Router, TanStack Start, Astro build, and `@expo/env` write raw `.env` values INTO process.env after the hook installs; resolution must happen on `get` (it does).
3. Turborepo: document `globalPassThroughEnv: ["KERSTEL_SOCKET", "KERSTEL_TOKEN_FILE", "KERSTEL_HOOK_DIR"]` in turbo.json; `NODE_OPTIONS` already passes.
4. A local `build` run without the hook embeds `kerstel://` literals in SvelteKit static private, Astro private import.meta.env, Nuxt runtimeConfig defaults, and Next prerendered HTML.

---

# Part B: Research B: prior art and portable shell (verified 2026-09-20/21)

## 1. dotenvx
- npm package (`@dotenvx/dotenvx`, bins `dotenvx`, `dx`), also brew/curl/winget/Docker. Scripts: `"start": "dotenvx run -- node index.js"`, `"dev": "dotenvx run -- next dev"` (https://dotenvx.com/docs/learn/installing/, https://github.com/dotenvx/dotenvx/blob/main/README.md). Being a devDependency, the "not installed" problem does not arise.
- Missing private key with `encrypted:` values: `decryptKeyValue.js` throws `MISSING_PRIVATE_KEY`; run action logs the error and still runs the command unless `--strict` (https://github.com/dotenvx/dotenvx/blob/main/src/cli/actions/run.js, https://dotenvx.com/docs/cli/run-strict/). Whether the literal `encrypted:` string reaches the child env: UNKNOWN.
- No "not installed, run anyway" story.
- Deploy: Next.js via `@dotenvx/next-env` (no script wrapping) (https://dotenvx.com/docs/nextjs/); Railway/Docker install the binary in the image and use `CMD ["dotenvx","run","--",...]` (https://dotenvx.com/docs/platforms/railway, https://dotenvx.com/docs/docker/); GitHub Actions `curl -sfS https://dotenvx.sh | sh` (https://dotenvx.com/docs/github-actions/).
- For Kerstel: degraded mode precedent is "log an error, run anyway" unless strict.

## 2. Doppler
- Native binary; npm package deprecated and non-functional (https://docs.doppler.com/docs/install-cli, https://docs.doppler.com/docs/saying-goodbye-to-the-doppler-client-packages-node-cli). No package.json guidance. Vercel/Netlify via sync integrations, no CLI in build (https://docs.doppler.com/docs/vercel, https://docs.doppler.com/docs/netlify). Docker: CLI in image + `DOPPLER_TOKEN`, `ENTRYPOINT ["doppler","run","--"]` (https://docs.doppler.com/docs/dockerfile). No fallback when absent.

## 3. Infisical
- Binary; npm `@infisical/cli` is a preinstall downloader (https://infisical.com/docs/cli/overview). `infisical run -- <cmd>`; CI via `INFISICAL_TOKEN` (https://infisical.com/docs/cli/commands/run). Vercel via Secret Sync (https://infisical.com/docs/integrations/secret-syncs/vercel). Docker: CLI in image (https://infisical.com/docs/integrations/platforms/docker). No package.json guidance, no fallback.

## 4. 1Password op
- Native binary, no npm (https://www.1password.dev/cli/get-started/). `op run --env-file`, `op inject` (https://www.1password.dev/cli/secrets-environment-variables/, https://www.1password.dev/cli/secrets-config-files/). CI via `OP_SERVICE_ACCOUNT_TOKEN`; GitHub Actions via `1password/load-secrets-action` (https://www.1password.dev/ci-cd/github-actions/). Pass-through of non-op:// values and unresolvable-reference behaviour: UNKNOWN. No fallback when absent.

## 5. direnv
- Shell prompt hook, never touches scripts (https://direnv.net/). Absent = scripts run unchanged without the env.

## 6. husky
- v9: `"prepare": "husky"`; `HUSKY=0` disables (https://typicode.github.io/husky/get-started.html). CI/Docker: `HUSKY=0`; prod without devDeps: `"prepare": "husky || true"`; silent skip via `.husky/install.mjs`:
  ```js
  if (process.env.NODE_ENV === 'production' || process.env.CI === 'true') { process.exit(0) }
  const husky = (await import('husky')).default
  console.log(husky())
  ```
  with `"prepare": "node .husky/install.mjs"` (https://typicode.github.io/husky/how-to.html). v8: `"prepare": "is-ci || husky install"` (https://raw.githubusercontent.com/typicode/husky/v8.0.3/docs/README.md).
- lefthook postinstall: skip when CI set and LEFTHOOK unset; warn and continue on failure (https://unpkg.com/lefthook@2.1.14/postinstall.js).
- For Kerstel: clearest precedent for a committed Node launcher that exits 0 when the tool is absent, with an env kill-switch.

## 7. Binary-via-npm and supply chain
- esbuild/turbo/biome/swc/lefthook: platform optionalDependencies + JS launcher, some with install-time download fallbacks (https://esbuild.github.io/getting-started/#install-esbuild, https://github.com/vercel/turborepo/blob/main/packages/turbo/bin/turbo, https://github.com/biomejs/biome/blob/main/packages/%40biomejs/biome/bin/biome, https://github.com/swc-project/swc/blob/main/packages/core/binding.js).
- Incidents: 8 Sep 2025 chalk/debug compromise (https://www.wiz.io/blog/widespread-npm-supply-chain-attack-breaking-down-impact-scope-across-debug-chalk); Shai-Hulud Sep 2025 and 2.0 Nov 2025 (https://unit42.paloaltonetworks.com/npm-supply-chain-attack/, https://securitylabs.datadoghq.com/articles/shai-hulud-2.0-npm-worm/); nx "s1ngularity" Aug 2025 malicious postinstall (https://github.com/nrwl/nx/security/advisories/GHSA-cxm3-wv7p-598c). esbuild/turbo/biome/swc/lefthook not on the community compromised list (https://raw.githubusercontent.com/Cobenian/shai-hulud-detect/main/compromised-packages.txt); completeness UNKNOWN.
- For Kerstel: every variant runs code at install time. A committed launcher must be inert: no download, no postinstall.

## 8. Portable conditional execution
- npm: `/bin/sh` on Unix, `cmd.exe` on Windows, `script-shell` config (https://docs.npmjs.com/cli/v10/commands/npm-run-script). pnpm: `scriptShell`, `shellEmulator` (https://pnpm.io/settings/other). Yarn Berry: always `@yarnpkg/shell`, bash-like, no control structures (https://github.com/yarnpkg/berry/blob/master/packages/yarnpkg-shell/README.md). Bun: bash/sh/zsh on Unix, Bun Shell on Windows, `--shell` overrides (https://bun.com/docs/cli/run); Bun Shell builtins lack `command` (https://bun.com/docs/runtime/shell).
- Empirical (Bun 1.4.2, `--shell=bun`): `x >/dev/null 2>&1 && a || b` fails to parse (`expected a command or assignment but got: "Redirect"`); `which x >/dev/null && a || b` works; `missing-bin exec -- echo || echo FALLBACK` falls through.
- cmd.exe: `&&`/`||` exist, no `command` builtin, no `/dev/null`; use `where /q`. `command -v kerstel ... && kerstel exec -- x || x` prints "'command' is not recognized" and then runs `x` by accident.
- cross-env only normalises `VAR=x cmd`; npm-run-all exists because cmd.exe lacks `&`. Neither offers "X if installed else Y".
- `node ./x.cjs` runs the same under npm, pnpm, Yarn, and `bun run` (Bun honours the node shebang; with node absent Bun ran it itself, observed, undocumented). `bun ./x.ts` only under Bun.
- For Kerstel: a shell one-liner cannot be portable across sh, cmd.exe, and the Bun Shell. `node ./launcher.cjs` is the only uniform form (husky's choice).

## 9. npm lifecycle
- npm: `pre<x>`/`post<x>` run around `npm run x`; `npm start` without a `start` script runs `node server.js`, and prestart/poststart still run (https://docs.npmjs.com/cli/v10/using-npm/scripts, https://docs.npmjs.com/cli/v10/commands/npm-start). pnpm: `enablePrePostScripts` default true (https://pnpm.io/settings/other), verified pnpm 11.22. Yarn Berry: no pre/post for user scripts (https://yarnpkg.com/advanced/lifecycle-scripts). Bun: runs `pre`/`post`, pre failure aborts (https://bun.com/docs/cli/run), verified.
- For Kerstel: `prebuild`/`prestart` are not a reliable injection point.

## Cross-cutting
- Vercel: `build` script if present, never `start` (https://vercel.com/docs/builds/configure-a-build). Railpack: `build` if present; `start` → `main` → `index.js` (https://railpack.com/languages/node). Fly dockerfile-node: `start` required, `build` optional (https://github.com/fly-apps/dockerfile-node/blob/main/README.md).
- No hosted secrets CLI (Doppler, Infisical, 1Password) asks users to run it inside host default commands; all use sync integrations or an image ENTRYPOINT.
- Net: (1) leave host-run build/start alone is what every binary-only peer does. (2) has husky's `node .husky/install.mjs` as precedent; keep the file inert. Pure-shell fallback is ruled out by cmd.exe and the Bun Shell.

---

# Part C: Research C: remaining deploy hosts (2026-09-20)

## 1. Google Cloud Buildpacks (Cloud Run source deploy, Cloud Functions, App Engine standard)
- Auto build: yes. `npm run build` if present. Precedence in `DetermineBuildCommands` (https://github.com/GoogleCloudPlatform/buildpacks/blob/main/pkg/nodejs/npm.go): `apphosting:build` → `APPHOSTING_BUILD` env → `GOOGLE_NODE_RUN_SCRIPTS` (comma list; empty = none) → `gcp-build` (empty = none) → `build`. Docs: https://docs.cloud.google.com/docs/buildpacks/nodejs
- Auto start: yes via npm. `DefaultStartCommand`: `start` script → `npm run start`; else `server.js` exists → `npm run start`; else `main` → `node <main>`; else `node index.js`. Procfile or `GOOGLE_ENTRYPOINT` bypasses npm. App Engine `entrypoint` in app.yaml overrides. Cloud Functions uses Functions Framework, not npm start.
- Special names: `gcp-build`, `apphosting:build`; env `GOOGLE_NODE_RUN_SCRIPTS`, `GOOGLE_ENTRYPOINT`; Procfile.
- Lifecycle: yes; always re-runs `npm install` on cache hit for pre/postinstall (cmd/nodejs/npm/lib/lib.go).
- devDeps: installed with `NODE_ENV=development` when a build script will run, then `npm prune --production`; launch layer sets `NODE_ENV=production`.

## 2. AWS Amplify Hosting
- Auto build: yes, via generated `amplify.yml` (`npm ci` then `npm run build`). https://docs.aws.amazon.com/amplify/latest/userguide/build-settings.html, https://docs.aws.amazon.com/amplify/latest/userguide/deploy-nextjs-app.html
- Amplify inspects the `build` script VALUE to classify Next apps (`next build` = SSG+SSR, `next build && next export` = SSG). Substring vs exact: UNKNOWN. A wrapped value may change classification.
- Auto start: no; SSR runs `node <entrypoint>` from `.amplify-hosting/compute/default` (https://docs.aws.amazon.com/amplify/latest/userguide/ssr-deployment-specification.html).
- Lifecycle: `npm ci`, so yes. NODE_ENV default: UNKNOWN.
- Override: `amplify.yml` in repo or console.

## 3. AWS Elastic Beanstalk (Node.js)
- Auto build: no documented build step.
- Auto start: Procfile → `npm start` → `app.js` → `server.js` (https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/create_deploy_nodejs.container.html).
- Lifecycle: `npm install --production`/`--omit=dev` only when node_modules absent (https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/nodejs-platform-dependencies.html). `NPM_USE_PRODUCTION=false` for devDeps.

## 4. Azure App Service (Linux) and Static Web Apps, via Oryx
- Auto build: `npm run build` then `npm run build:azure`, in that order (https://github.com/microsoft/Oryx/blob/main/doc/runtimes/nodejs.md, https://learn.microsoft.com/en-us/azure/app-service/configure-language-nodejs, https://learn.microsoft.com/en-us/azure/static-web-apps/build-configuration).
- Auto start (App Service): `npm start` if `start` → `main` → `bin/www`, `server.js`, `app.js`, `index.js`, `hostingstart.js`. SWA has no start.
- Special names: `build:azure`; env `PRE_BUILD_COMMAND`, `POST_BUILD_COMMAND`, `CUSTOM_BUILD_COMMAND`, `RUN_BUILD_COMMAND`, `DISABLE_NODEJS_BUILD`, `PRUNE_DEV_DEPENDENCIES` (https://github.com/microsoft/Oryx/blob/main/doc/configuration.md).
- Lifecycle: yes, `npm install` with devDeps; `prebuild`/`postbuild` fire.
- Override: `az webapp config set --startup-file`; SWA `app_build_command`, `skip_app_build`.

## 5. DigitalOcean App Platform (Heroku-derived Node buildpack)
- Auto build: `build` script; `heroku-prebuild`, `heroku-postbuild`, `heroku-cleanup` honoured (https://docs.digitalocean.com/products/app-platform/reference/buildpacks/nodejs/). Upstream: if both `build` and `heroku-postbuild` exist only `heroku-postbuild` runs (https://github.com/heroku/heroku-buildpack-nodejs/blob/main/lib/package_manager.sh). DO's exact precedence: partially UNKNOWN.
- Auto start: `npm start` default run command (https://docs.digitalocean.com/products/app-platform/how-to/manage-services/). Procfile support: UNKNOWN.
- Lifecycle: `npm ci` by default; pre/postinstall run.
- Override: `build_command`, `run_command` in app spec (https://docs.digitalocean.com/products/app-platform/how-to/build-run-commands/).
- devDeps installed then pruned unless `NPM_CONFIG_PRODUCTION=false` etc.

## 6. GitHub Actions / Pages
- Nothing auto-runs. `actions/setup-node` installs Node only (https://github.com/actions/setup-node/blob/main/README.md). Docs have users write `npm ci`, `npm run build --if-present`, `npm test` (https://docs.github.com/en/actions/use-cases-and-examples/building-and-testing/building-and-testing-nodejs). Pages actions run no npm scripts.

## 7. Expo EAS Build
- No `build`/`start` script run. Steps: `npm install`, `npx expo-doctor`, `npx expo prebuild`, Gradle/Xcode (https://docs.expo.dev/build-reference/android-builds/). Web: `npx expo export -p web`.
- Hooks: `eas-build-pre-install`, `eas-build-post-install`, `eas-build-on-success`, `eas-build-on-error`, `eas-build-on-cancel`, `eas-build-on-complete` (https://docs.expo.dev/build-reference/npm-hooks/).
- Lifecycle: `npm install` runs so postinstall/prepare run. devDeps pruning: UNKNOWN.

## 8. Docker CMD conventions (official docs)
| Framework | Build | Runtime CMD | Through package.json script? |
|---|---|---|---|
| Next.js with-docker / Docker guide (standalone) | `npm run build` | `node server.js` (https://github.com/vercel/next.js/blob/canary/examples/with-docker/Dockerfile) | build yes, start no |
| Next.js Node server (non-Docker) | `npm run build` | `npm run start` (https://nextjs.org/docs/app/getting-started/deploying) | both |
| Nuxt node-server | `nuxt build` | `node .output/server/index.mjs` (https://nuxt.com/docs/4.x/getting-started/deployment) | build usually via script; start no |
| SvelteKit adapter-node | `npm run build` | `node build` (https://svelte.dev/docs/kit/adapter-node) | build yes, start no |
| React Router default template | `RUN npm run build` | `CMD ["npm","run","start"]` (https://github.com/remix-run/react-router-templates/blob/main/default/Dockerfile) | both |
| Astro @astrojs/node | `astro build` | `node ./dist/server/entry.mjs` | build usually via script; start no |
| NestJS | `npm run build` | `node dist/main` (https://docs.nestjs.com/deployment) | build yes, start no |
| Bun docker guide | optional `bun run build` | `bun run index.ts` (https://bun.com/guides/ecosystem/docker) | build yes if present; start no |

## 9. Netlify detection
Framework detection uses `npmDependencies=['next']` + config files, not the script value (https://github.com/netlify/build/blob/main/packages/build-info/src/frameworks/next.ts). Script choice is a substring test `scriptValue.includes(frameworkBuildCommand)` in `getBuildCommands` (https://github.com/netlify/build/blob/main/packages/build-info/src/get-commands.ts). `kerstel exec -- next build` still matches.

## 10. devDependencies at install
| Host | Install | devDeps? |
|---|---|---|
| Google Buildpacks | `npm ci` with NODE_ENV=development when building, then prune | yes then pruned |
| Amplify | `npm ci` | yes |
| Elastic Beanstalk | `--production`/`--omit=dev` | no unless `NPM_USE_PRODUCTION=false` |
| Azure Oryx | `npm install` | yes |
| DigitalOcean | `npm ci` | yes then pruned |
| GitHub Actions | user-written | yes by default |
| EAS | `npm install` | yes; pruning UNKNOWN |

## Notes
- Hosts that auto-run both build and start with no Procfile: Google Buildpacks, Azure App Service, DigitalOcean. Elastic Beanstalk breaks only at start.
- Amplify's build-script classification is the one place a wrapped value may change host behaviour beyond "not found".
- Official Docker guidance almost universally builds via `npm run build` (wrapper hit inside image build) and starts with `node <file>` (wrapper bypassed).
