# Image Docker — la cible « demo, CI, utilisateurs techniques » du brief (§2).
#
# Elle emballe le meme bundle que `npx` et que l'executable Windows : un seul artefact,
# trois emballages (ADR-022). L'etage de construction garde npm et les devDependencies ;
# l'image finale ne recoit que `dist/`.
#
# **Aucun EXPOSE, et c'est delibere.** L'interface n'ecoute que sur 127.0.0.1 et cette
# adresse n'est pas reglable : depuis un conteneur, une publication de port ne l'atteint
# donc pas. Annoncer un port laisserait croire le contraire. L'image sert le pipeline ;
# pour l'interface, voir l'ADR-023 et le README (`--network host`, sous Linux).

FROM node:24-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN node scripts/build.ts

FROM node:24-alpine
LABEL org.opencontainers.image.title="annuaire-vie-associative"
LABEL org.opencontainers.image.description="Constitution d'annuaires de la vie associative locale a partir des donnees ouvertes."

WORKDIR /app
COPY --from=build /build/dist ./

# Les donnees vivent dans un volume : la base SQLite, le cache HTTP et les dumps
# survivent au conteneur, et la purge a trois ans continue de s'appliquer au demarrage.
ENV ANNUAIRE_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

ENTRYPOINT ["node", "/app/annuaire.cjs"]
CMD ["--help"]
