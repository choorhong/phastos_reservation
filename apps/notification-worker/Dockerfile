# Built from the repo root (monorepo: one package.json/node_modules shared
# by all three apps' libs) -- e.g.
# `docker build -f apps/notification-worker/Dockerfile .`.
#
# `nest build` (webpack) externalizes node_modules rather than bundling them
# (standard for a Nest CLI webpack build -- see PROGRESS.md's Gotchas #1),
# so the runtime stage needs its own `npm ci` too, not just the built
# `main.js`.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx nest build notification-worker

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/apps/notification-worker/main.js ./dist/apps/notification-worker/main.js

EXPOSE 3001
CMD ["node", "dist/apps/notification-worker/main.js"]
