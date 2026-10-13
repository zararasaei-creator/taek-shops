# syntax=docker/dockerfile:1
#
# CI-ONLY S3-compatible test server: MinIO server + `mc`, built from MinIO's OFFICIAL source at
# pinned release tags. NOT a production image, never pushed anywhere, never used outside
# ci/docker-compose.ci.yml.
#
# Why this exists: MinIO stopped publishing prebuilt images and binaries for the community
# edition. Verified 2026-10-13: anonymous pulls of quay.io/minio/{minio,mc} return
# "unauthorized" for every tag, minio/minio is gone from Docker Hub, and dl.min.io answers
# 410 Gone for every binary (including the signed ones the upstream Dockerfile.release
# downloads). github.com/minio/minio and github.com/minio/mc are archived, source-only
# (README: build from source; `go install`). Nothing here trusts an unofficial mirror.
#
# Provenance / integrity:
#   - source: github.com/minio/minio and github.com/minio/mc, fetched by `go install <module>@<tag>`
#     through the Go module proxy; Go verifies module contents against go.sum and the public
#     checksum database. Tags are pinned below.
#   - base images are official (Docker Hub `golang`, Red Hat `ubi9/ubi-micro`, which upstream's
#     own Dockerfile.release also uses) and pinned by digest.
# Licence: MinIO and mc are GNU AGPLv3. This image is built and run, unmodified, only as a
#   disposable test dependency; it is not distributed or offered as a network service.
# Security: the pinned server (RELEASE.2025-10-15) includes the Oct-2025 privilege-escalation fix,
#   but the upstream project is archived, so there will be NO further security updates. Acceptable
#   only for a throwaway loopback test server with synthetic credentials — never for real data.
# Version string: a `go install` build reports a development version, not a release stamp.

ARG MINIO_TAG=RELEASE.2025-10-15T17-29-55Z
ARG MC_TAG=RELEASE.2025-08-13T08-35-41Z

FROM golang:1.24-alpine@sha256:8bee1901f1e530bfb4a7850aa7a479d17ae3a18beb6e09064ed54cfd245b7191 AS build
ARG MINIO_TAG
ARG MC_TAG
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
RUN go install -ldflags "-s -w" github.com/minio/minio@${MINIO_TAG} \
 && go install -ldflags "-s -w" github.com/minio/mc@${MC_TAG}

FROM registry.access.redhat.com/ubi9/ubi-micro@sha256:5be877a2a280ae36eb9ab80ca4efb28bbf77c57abbba38137cdc37a03b8465e6
ARG MINIO_TAG
ARG MC_TAG
LABEL org.opencontainers.image.title="taek-shops CI MinIO (source-built, test only)" \
      org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      minio.tag="${MINIO_TAG}" mc.tag="${MC_TAG}"
ENV MC_CONFIG_DIR=/tmp/.mc
COPY --from=build /go/bin/minio /go/bin/mc /usr/bin/
EXPOSE 9000 9001
VOLUME ["/data"]
# `minio` is the entrypoint so compose can pass `server /data ...`; `mc` is on PATH for the
# existing `mc ready local` healthcheck.
ENTRYPOINT ["/usr/bin/minio"]
CMD ["server", "/data"]
