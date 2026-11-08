# Projekt-FEM als Server (Bedienung im Browser), z. B. neben MathPad auf demselben Rechner.
# Bauen und starten: siehe server/README.md (docker compose up -d --build)

# 1) Oberfläche bauen
FROM node:22-bookworm-slim AS ui
WORKDIR /src/app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
RUN npx vite build

# 2) Rechenkern + Server bauen (die Oberfläche wird eingebettet)
FROM rust:1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libsoup-3.0-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
COPY --from=ui /src/app/dist app/dist
RUN cargo build --release -p projekt-fem-app -p fem-cli

# 3) Laufzeit: nur das Programm, Gmsh (Vernetzung) und die nötigen Bibliotheken
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-0 libgtk-3-0 ca-certificates python3 python3-pip python-is-python3 \
      libgl1 libglu1-mesa libxcursor1 libxft2 libxinerama1 libxrender1 libfontconfig1 libgomp1 \
    && pip3 install --no-cache-dir --break-system-packages gmsh \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/projekt-fem-app /src/target/release/projekt-fem /usr/local/bin/
# Einstellungen, Werkstoffe, Onshape-Schlüssel und CAD-Eingang bleiben im Volume /daten
ENV XDG_CONFIG_HOME=/daten \
    PROJEKT_FEM_OEFFENTLICH=1 \
    RUST_LOG=warn
VOLUME /daten
EXPOSE 8790
HEALTHCHECK --interval=60s --timeout=5s CMD python3 -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:8790/')" || exit 1
CMD ["projekt-fem-app", "--server", "--port", "8790"]
