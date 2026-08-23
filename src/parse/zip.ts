import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

/**
 * Lecteur ZIP minimal, en lecture seule.
 *
 * Il ne sert qu'a `--rna-file` : le dump officiel du RNA est un ZIP dont chaque entree
 * est le CSV d'un departement, et l'utilisateur qui le fournit n'a aucune raison de
 * l'avoir decompresse. On lit le catalogue en fin de fichier puis on n'inflate que
 * l'entree demandee — inutile de detendre 400 Mo pour en lire 23.
 *
 * `node:zlib` couvre deflate, qui est la seule methode employee par ces archives.
 * Aucun module natif n'est requis.
 *
 * Zip64 n'est pas gere : les archives visees comptent une centaine d'entrees pour
 * quelques centaines de Mo, loin des limites. Un fichier Zip64 est rejete explicitement
 * plutot que lu de travers.
 */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

const TAILLE_EOCD = 22;
const COMMENTAIRE_MAX = 0xffff;
const METHODE_STOCKEE = 0;
const METHODE_DEFLATE = 8;

export type ZipEntry = {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
};

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export class ZipReader {
  readonly #fd: number;
  readonly #entrees: readonly ZipEntry[];
  /** Taille du fichier : elle borne tout ce que le catalogue pretend pouvoir lire. */
  readonly #taille: number;

  private constructor(fd: number, entrees: readonly ZipEntry[], taille: number) {
    this.#fd = fd;
    this.#entrees = entrees;
    this.#taille = taille;
  }

  static ouvrir(chemin: string): ZipReader {
    const fd = openSync(chemin, "r");
    try {
      const taille = fstatSync(fd).size;
      return new ZipReader(fd, lireCatalogue(fd, taille), taille);
    } catch (erreur) {
      closeSync(fd);
      throw erreur;
    }
  }

  entrees(): readonly ZipEntry[] {
    return this.#entrees;
  }

  /** Rend la premiere entree dont le nom satisfait le predicat. */
  trouver(predicat: (nom: string) => boolean): ZipEntry | undefined {
    return this.#entrees.find((entree) => predicat(entree.name));
  }

  /** Detend une entree et rend son contenu brut. */
  lire(entree: ZipEntry): Buffer {
    const enteteLocal = lireBloc(this.#fd, entree.localHeaderOffset, 30, this.#taille);
    if (enteteLocal.readUInt32LE(0) !== SIG_LOCAL) {
      throw new ZipError(`En-tete local absent pour l'entree ${entree.name}`);
    }
    // Les longueurs de nom et de champ extra peuvent differer de celles du catalogue :
    // ce sont celles de l'en-tete local qui donnent le debut reel des donnees.
    const longueurNom = enteteLocal.readUInt16LE(26);
    const longueurExtra = enteteLocal.readUInt16LE(28);
    const debut = entree.localHeaderOffset + 30 + longueurNom + longueurExtra;
    const donnees = lireBloc(this.#fd, debut, entree.compressedSize, this.#taille);

    if (entree.method === METHODE_STOCKEE) return donnees;
    if (entree.method !== METHODE_DEFLATE) {
      throw new ZipError(`Methode de compression ${entree.method} non geree (${entree.name})`);
    }
    // `maxOutputLength` **avant** de decompresser, et non le controle de taille qui suit :
    // celui-ci arrive trop tard, l'entree declarant dix kilo-octets et en contenant dix
    // giga-octets a deja ete deroulee en memoire. Le catalogue d'un zip est declaratif, il
    // vient du meme fichier que les donnees : il ne se croit pas sur parole.
    const contenu = inflateRawSync(donnees, { maxOutputLength: entree.uncompressedSize + 1 });
    if (contenu.byteLength !== entree.uncompressedSize) {
      throw new ZipError(
        `Taille inattendue pour ${entree.name} : ${contenu.byteLength} au lieu de ${entree.uncompressedSize}`,
      );
    }
    return contenu;
  }

  fermer(): void {
    closeSync(this.#fd);
  }
}

function lireCatalogue(fd: number, taille: number): ZipEntry[] {
  const fenetre = Math.min(taille, TAILLE_EOCD + COMMENTAIRE_MAX);
  const queue = lireBloc(fd, taille - fenetre, fenetre);

  let position = -1;
  for (let i = queue.length - TAILLE_EOCD; i >= 0; i--) {
    if (queue.readUInt32LE(i) === SIG_EOCD) {
      position = i;
      break;
    }
  }
  if (position < 0) {
    throw new ZipError("Fin de catalogue introuvable : le fichier n'est pas un ZIP");
  }

  const nombre = queue.readUInt16LE(position + 10);
  const tailleCatalogue = queue.readUInt32LE(position + 12);
  const offsetCatalogue = queue.readUInt32LE(position + 16);

  if (nombre === 0xffff || tailleCatalogue === 0xffffffff || offsetCatalogue === 0xffffffff) {
    throw new ZipError("Archive Zip64 non geree");
  }
  for (let i = queue.length - 4; i >= 0; i--) {
    if (queue.readUInt32LE(i) === SIG_EOCD64) {
      throw new ZipError("Archive Zip64 non geree");
    }
  }

  const catalogue = lireBloc(fd, offsetCatalogue, tailleCatalogue);
  const entrees: ZipEntry[] = [];
  let curseur = 0;
  for (let index = 0; index < nombre; index++) {
    if (curseur + 46 > catalogue.length || catalogue.readUInt32LE(curseur) !== SIG_CENTRAL) {
      throw new ZipError(`Catalogue corrompu a l'entree ${index}`);
    }
    const longueurNom = catalogue.readUInt16LE(curseur + 28);
    const longueurExtra = catalogue.readUInt16LE(curseur + 30);
    const longueurCommentaire = catalogue.readUInt16LE(curseur + 32);
    entrees.push({
      name: catalogue.subarray(curseur + 46, curseur + 46 + longueurNom).toString("utf8"),
      method: catalogue.readUInt16LE(curseur + 10),
      compressedSize: catalogue.readUInt32LE(curseur + 20),
      uncompressedSize: catalogue.readUInt32LE(curseur + 24),
      localHeaderOffset: catalogue.readUInt32LE(curseur + 42),
    });
    curseur += 46 + longueurNom + longueurExtra + longueurCommentaire;
  }
  return entrees;
}

function lireBloc(fd: number, position: number, longueur: number, taille?: number): Buffer {
  // `longueur` vient d'un uint32 lu dans le catalogue. Un champ a 0xFFFFFFFF faisait
  // lever a `Buffer.alloc` un `RangeError` de V8 — ni une `ZipError`, ni quelque chose
  // que les appelants attrapent. Une longueur qui deborde du fichier est une erreur de
  // format, et doit se dire comme telle.
  if (!Number.isSafeInteger(longueur) || longueur < 0) {
    throw new ZipError(`Longueur de bloc invalide : ${longueur}`);
  }
  if (taille !== undefined && position + longueur > taille) {
    throw new ZipError(`Bloc annonce hors du fichier : ${position}+${longueur} > ${taille}`);
  }
  const tampon = Buffer.alloc(longueur);
  let lus = 0;
  while (lus < longueur) {
    const n = readSync(fd, tampon, lus, longueur - lus, position + lus);
    if (n === 0) throw new ZipError("Fin de fichier prematuree");
    lus += n;
  }
  return tampon;
}
