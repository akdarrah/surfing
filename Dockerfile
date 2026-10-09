# Every build stage runs on the build machine's own arch (no QEMU); only the final scratch stage is amd64.
FROM --platform=$BUILDPLATFORM node:22-slim AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client ./
COPY levels /app/levels
RUN npm run build

FROM --platform=$BUILDPLATFORM ghcr.io/rust-cross/rust-musl-cross:x86_64-musl AS server
WORKDIR /app/server
COPY server ./
COPY levels /app/levels
RUN cargo build --release --bin sky-surf-server --target x86_64-unknown-linux-musl

FROM scratch
COPY --from=server /app/server/target/x86_64-unknown-linux-musl/release/sky-surf-server /sky-surf-server
COPY --from=client /app/client/dist /app/dist
COPY levels /app/levels
ENV STATIC_DIR=/app/dist LEVEL=/app/levels/cloud-harbor.json DATA_DIR=/data PORT=80
EXPOSE 80
ENTRYPOINT ["/sky-surf-server"]
