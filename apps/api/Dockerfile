# Built from the repo root (monorepo: one package.json/node_modules shared
# by all three apps' libs) -- e.g. `docker build -f apps/api/Dockerfile .`.
#
# `nest build` (webpack) externalizes node_modules rather than bundling them
# (standard for a Nest CLI webpack build -- see docs/progress.md's Gotchas #1),
# so the runtime stage needs its own `npm ci` too, not just the built
# `main.js`.
#
# Migrations aren't run by the api itself. The `migrate` stage below is a
# one-shot image (`--target migrate`) that runs them with the TypeORM CLI;
# docker-compose.prod.yml runs it before starting the apps. It sits between
# `build` and `runtime` so a plain `docker build` (CI) still produces the
# runtime image, which is always the last stage.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx nest build api

# Reuses the build stage (full source + dev dependencies: ts-node, the
# TypeORM CLI and the .ts migrations under libs/database/migrations).
FROM build AS migrate
CMD ["npm", "run", "typeorm", "--", "migration:run", "-d", "libs/database/src/data-source.ts"]

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/apps/api/main.js ./dist/apps/api/main.js

EXPOSE 3000
CMD ["node", "dist/apps/api/main.js"]
