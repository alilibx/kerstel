# The kerstel-server image. Built by .github/workflows/nightly.yml from
# binaries it already compiled and smoke-tested, so nothing is built here and
# no RUN step needs an emulator for the other architecture. The build context
# holds amd64/kerstel-server, arm64/kerstel-server and data/.
#
# The binary links only glibc, which distroless/base provides. The image has
# no shell and runs as the distroless nonroot user (65532).
FROM gcr.io/distroless/base-debian12:nonroot
ARG TARGETARCH
COPY --chmod=0755 ${TARGETARCH}/kerstel-server /usr/local/bin/kerstel-server
# A named volume copies this directory's owner, so the server can write to it.
COPY --chown=65532:65532 data/ /data/
ENV KERSTEL_SERVER_DB=/data/kerstel-server.db \
    KERSTEL_SERVER_LISTEN=0.0.0.0:8787
VOLUME /data
EXPOSE 8787
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/kerstel-server"]
