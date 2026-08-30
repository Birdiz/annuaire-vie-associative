/**
 * Rendu HTML de l'UI locale.
 *
 * **Tout ce qui vient du crawl passe par `echapperHtml`.** Un nom d'association, une
 * adresse, une URL source sont des chaines lues sur un site que nous ne controlons pas :
 * c'est exactement la meme precaution que l'echappement des formules a l'export
 * (`src/export/csv.ts`), et elle vaut d'autant plus ici que l'ecran de revue est
 * l'endroit ou l'on regarde ces valeurs de pres. La CSP du serveur ferme la porte une
 * seconde fois ; aucune des deux ne dispense de l'autre.
 *
 * Pas de moteur de gabarit : des fonctions qui rendent des chaines. Le poids du bundle
 * est un critere de conception, et une dependance de plus ne se justifierait pas pour
 * trois ecrans.
 */

import type { Amorce } from "./requetes.ts";

const ENTITES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Echappe pour un noeud texte **et** pour une valeur d'attribut : les deux formes de
 * guillemets sont couvertes, si bien qu'un seul echappement suffit partout. Une fonction
 * par contexte laisserait le choix a l'appelant, donc l'occasion de se tromper.
 */
export function echapperHtml(valeur: unknown): string {
  return String(valeur ?? "").replace(/[&<>"']/g, (caractere) => ENTITES[caractere] ?? caractere);
}

/**
 * Une URL collectee n'est rendue en lien que si elle est http(s). Sans ce filtre, une
 * page piegee pourrait faire porter un `javascript:` a un href — l'echappement seul ne
 * l'empecherait pas, il ne protege que la syntaxe du document.
 */
export function lienSur(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? echapperHtml(url) : undefined;
}

export function nombre(valeur: number): string {
  return valeur.toLocaleString("fr-FR");
}

/** La marque du pluriel, en francais : zero et un restent au singulier. */
export function pluriel(valeur: number): string {
  return Math.abs(valeur) >= 2 ? "s" : "";
}

export function pourcent(numerateur: number, denominateur: number): string {
  if (denominateur === 0) return "—";
  return `${((numerateur / denominateur) * 100).toFixed(1).replace(".", ",")} %`;
}

/**
 * Un volume d'octets en clair : « 1,25 Go », « 340 Mo ».
 *
 * Sert a dire ou en est la lecture du dump RNA. Les paliers s'arretent au gigaoctet :
 * au-dela le chiffre ne dit plus rien a qui regarde avancer une amorce, et en deca du
 * megaoctet il n'y a rien a regarder.
 */
export function octets(valeur: number): string {
  const borne = Math.max(0, valeur);
  if (borne < 1024 * 1024) return `${Math.round(borne / 1024).toLocaleString("fr-FR")} Ko`;
  if (borne < 1024 * 1024 * 1024) return `${Math.round(borne / (1024 * 1024)).toLocaleString("fr-FR")} Mo`;
  return `${(borne / (1024 * 1024 * 1024)).toFixed(2).replace(".", ",")} Go`;
}

/**
 * Horodatage lisible : « 30/08/2026 13:05 », dans le fuseau de la machine.
 *
 * Les colonnes de la base portent de l'ISO 8601 en UTC, et cela ne doit pas changer :
 * c'est ce qui rend les comparaisons de dates justes et l'ordre lexical fiable. Mais
 * `2026-08-30T11:05:29.852Z` demande a celui qui le lit de convertir un fuseau de tete
 * pour savoir si son run a demarre il y a deux minutes ou hier soir. L'outil tourne sur
 * sa machine : c'est l'heure de sa machine qu'il faut afficher.
 *
 * Formate a la main plutot que par `Intl` : les accesseurs `getDate`/`getHours` lisent le
 * fuseau a chaque appel — un formateur `Intl` garde en cache celui qu'il avait a sa
 * construction — et le rendu ne depend alors d'aucune donnee de locale. Le format est
 * francais parce que toute l'interface l'est.
 */
export function dateHeure(valeur: string | null | undefined): string {
  if (valeur === null || valeur === undefined || valeur === "") return "—";
  const date = new Date(valeur);
  // Une valeur illisible est rendue telle quelle : elle vient de la base, et la masquer
  // derriere un tiret ferait passer une donnee corrompue pour une donnee absente.
  if (Number.isNaN(date.getTime())) return echapperHtml(valeur);
  return `${deuxChiffres(date.getDate())}/${deuxChiffres(date.getMonth() + 1)}/${date.getFullYear()} ` +
    `${deuxChiffres(date.getHours())}:${deuxChiffres(date.getMinutes())}`;
}

/**
 * Une date seule, « 2023-08-30 » rendu « 30/08/2023 ».
 *
 * Relue caractere par caractere, sans passer par `Date` : `new Date("2023-08-30")` vaut
 * minuit UTC, et a l'ouest de Greenwich l'affichage local retomberait sur la veille. Une
 * borne de dormance decalee d'un jour se lirait comme une erreur de calcul.
 */
export function jour(valeur: string | null | undefined): string {
  if (valeur === null || valeur === undefined) return "—";
  const parties = /^(\d{4})-(\d{2})-(\d{2})/.exec(valeur);
  if (parties === null) return echapperHtml(valeur);
  return `${parties[3]}/${parties[2]}/${parties[1]}`;
}

/**
 * Une duree en clair : « 38 s », « 12 min », « 1 h 07 ».
 *
 * Trois paliers, parce qu'au-dela la precision ne sert plus a rien : ce qu'on veut savoir
 * d'un run de quarante minutes est qu'il en est a douze, pas qu'il en est a 12 min 34 s.
 */
export function duree(millisecondes: number): string {
  const secondes = Math.max(0, Math.round(millisecondes / 1000));
  if (secondes < 60) return `${secondes} s`;
  const minutes = Math.floor(secondes / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${deuxChiffres(minutes % 60)}`;
}

/** Ecart entre deux horodatages, ou `undefined` si l'un des deux est illisible. */
export function ecart(debut: string, fin: string | number): number | undefined {
  const depart = new Date(debut).getTime();
  const arrivee = typeof fin === "number" ? fin : new Date(fin).getTime();
  if (Number.isNaN(depart) || Number.isNaN(arrivee)) return undefined;
  return arrivee - depart;
}

function deuxChiffres(valeur: number): string {
  return String(valeur).padStart(2, "0");
}

/**
 * Barre de progression, en `<progress>` natif.
 *
 * **Pas de `style="width: 60%"`.** La CSP du serveur est `default-src 'self'`, donc
 * `style-src 'self'` : un attribut `style` en ligne est refuse par le navigateur, et la
 * barre resterait vide sans que rien ne le signale. Y ajouter `'unsafe-inline'` pour
 * dessiner un rectangle serait payer un affichage du garde-fou qui protege l'ecran de
 * revue. L'element natif porte sa valeur dans un attribut, se met en forme en CSS, et
 * annonce tout seul sa progression aux lecteurs d'ecran.
 */
export function barre(faits: number, total: number, libelle: string, phrase?: string): string {
  const borne = Math.max(0, Math.min(faits, total));
  // `phrase` sert aux unites qui ne se comptent pas : « 340 Mo sur 1,25 Go » se lit,
  // « 356 515 840 sur 1 342 177 280 octets » non.
  const texte = phrase ?? `${nombre(borne)} sur ${nombre(total)} ${libelle}`;
  return `<div class="progression">
  <progress max="${total}" value="${borne}" aria-label="${echapperHtml(texte)}"></progress>
  <span class="etiquette">${echapperHtml(texte)} — ${pourcent(borne, total)}</span>
</div>`;
}

export type Onglet = "synthese" | "revue" | "export";

/** Le chemin de chaque onglet. La barre de portee y renvoie, pour rester sur l'ecran. */
export const CHEMIN_ONGLET: Record<Onglet, string> = {
  synthese: "/",
  revue: "/revue",
  export: "/export",
};

/**
 * De quoi rendre la barre de portee : le departement affiche, ceux que la base connait
 * deja, et ce qu'elle contient pour celui-ci.
 */
export type DonneesPortee = {
  departement: string;
  departements: readonly string[];
  onglet: Onglet;
  amorce: Amorce;
  /** Message quand le code saisi n'a pas la forme d'un departement. */
  refus: string | undefined;
};

/**
 * La barre de portee : **le seul endroit de l'interface ou le departement se dit**.
 *
 * Elle remplace un selecteur qui ne s'affichait qu'a partir de deux departements en base
 * et ne listait que l'existant. Consequence : depuis une base amorcee sur le seul 35, il
 * n'y avait aucun chemin vers le 88 — le departement etait partout a l'ecran et nulle
 * part modifiable, et il fallait passer par la ligne de commande pour en ouvrir un autre.
 *
 * D'ou une **saisie libre** plutot qu'une liste : un departement qui n'est pas encore en
 * base est justement celui qu'on veut pouvoir demander. Les departements deja amorces
 * restent offerts, en liens et en `datalist` — un `datalist` seul est une affordance
 * invisible.
 *
 * Le `pattern` reprend la forme acceptee par le pipeline (35, 2A, 971). Il fait refuser
 * la saisie par le navigateur avant l'aller-retour ; le serveur revalide de son cote,
 * puisqu'une contrainte de formulaire ne protege rien.
 */
export function barrePortee(donnees: DonneesPortee): string {
  const chemin = CHEMIN_ONGLET[donnees.onglet];
  const courant = echapperHtml(donnees.departement);

  const connus = donnees.departements.filter((dept) => dept !== donnees.departement);
  const liste = connus
    .map(
      (dept) =>
        `<a href="${chemin}?departement=${encodeURIComponent(dept)}">${echapperHtml(dept)}</a>`,
    )
    .join(" ");
  const options = donnees.departements
    .map((dept) => `<option value="${echapperHtml(dept)}"></option>`)
    .join("");

  const etat =
    donnees.amorce.communes === 0
      ? `<span class="vide">Jamais amorce. Le lancer le remplira depuis le registre national.</span>`
      : `<span>${nombre(donnees.amorce.associations)} association${pluriel(donnees.amorce.associations)}
         dans ${nombre(donnees.amorce.communes)} commune${pluriel(donnees.amorce.communes)}</span>`;

  const autres = liste === "" ? "" : `<span class="autres">Deja en base : ${liste}</span>`;
  const refus = donnees.refus === undefined ? "" : `<p class="refus">${echapperHtml(donnees.refus)}</p>`;

  return `<div class="portee">
  <form method="get" action="${chemin}">
    <label for="portee-departement">Departement</label>
    <input type="text" id="portee-departement" name="departement" value="${courant}"
           list="portee-connus" size="4" maxlength="3" autocomplete="off" required
           pattern="[0-9]{2}|[0-9][ABab]|[0-9]{3}"
           title="Deux chiffres (35), un chiffre et une lettre en Corse (2A), trois chiffres outre-mer (971).">
    <datalist id="portee-connus">${options}</datalist>
    <button type="submit">Ouvrir</button>
  </form>
  ${etat}
  ${autres}
</div>
${refus}`;
}

export type OptionsPage = {
  titre: string;
  onglet: Onglet;
  departement: string;
  contenu: string;
  version: string;
  /** La barre de portee, deja rendue : la page ne lit pas la base. */
  portee: string;
};

export function page(options: OptionsPage): string {
  const onglet = (cible: Onglet, libelle: string): string =>
    `<a href="${CHEMIN_ONGLET[cible]}?departement=${encodeURIComponent(options.departement)}"` +
    `${options.onglet === cible ? ' class="actif" aria-current="page"' : ""}>${libelle}</a>`;

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${echapperHtml(options.titre)} — annuaire</title>
<link rel="stylesheet" href="/assets/annuaire.css">
<!-- htmx n'echange par defaut que les reponses 2xx. Un arbitrage refuse repond 422 —
     le code dit la verite sur ce qui s'est passe — et son corps porte le message a
     lire : il faut donc l'autoriser explicitement. La configuration passe par une
     balise meta et non par du script, que la CSP interdit. -->
<meta name="htmx-config" content='{"responseHandling":[{"code":"204","swap":false},{"code":"[23]..","swap":true},{"code":"422","swap":true},{"code":"[45]..","swap":false,"error":true}]}'>
<script src="/assets/htmx.min.js" defer></script>
</head>
<body>
<header>
  <span class="marque">Annuaire de la vie associative</span>
  <nav>
    ${onglet("synthese", "Synthese")}
    ${onglet("revue", "Revue")}
    ${onglet("export", "Export")}
  </nav>
  <span class="version">v${echapperHtml(options.version)}</span>
</header>
${options.portee}
<main>
${options.contenu}
</main>
<footer>
  Serveur local : rien de ce qui est affiche ici ne sort de cette machine.
</footer>
</body>
</html>
`;
}

/** Marqueur des cellules numeriques, pose par l'appelant qui sait ce qu'il rend. */
const MARQUE_NOMBRE = '<span class="n">';

/**
 * Tableau simple : en-tetes, puis des cellules deja rendues.
 *
 * **Une colonne de nombres s'aligne a droite, en-tete comprise.** Le CSS alignait la
 * cellule et pas le titre : sur la table des etats de la file — six nombres, une seule
 * ligne — chaque valeur flottait a droite d'un titre reste a gauche, et on ne savait plus
 * quel chiffre allait avec quel etat. La colonne est reconnue a `span.n`, le marqueur que
 * l'appelant pose deja : le passer une seconde fois en parametre laisserait les deux se
 * contredire.
 */
export function tableau(entetes: readonly string[], lignes: readonly (readonly string[])[]): string {
  if (lignes.length === 0) return '<p class="discret">Rien a afficher.</p>';
  const numerique = entetes.map((_, colonne) =>
    lignes.every((ligne) => (ligne[colonne] ?? "").startsWith(MARQUE_NOMBRE)),
  );
  const classe = (colonne: number): string => (numerique[colonne] === true ? ' class="num"' : "");

  return `<table>
<thead><tr>${entetes.map((titre, i) => `<th${classe(i)}>${echapperHtml(titre)}</th>`).join("")}</tr></thead>
<tbody>
${lignes
  .map((ligne) => `<tr>${ligne.map((cellule, i) => `<td${classe(i)}>${cellule}</td>`).join("")}</tr>`)
  .join("\n")}
</tbody>
</table>`;
}

/**
 * Ce que l'interface sait d'une collecte en cours.
 *
 * Deux cas, et ils n'autorisent pas la meme fermete. `pilote` : c'est cette interface qui
 * a lance le run, le fait est certain. `orphelin` : une ligne `run` est restee « en cours »
 * sans que le pilote la tienne — soit un `annuaire run` dans un terminal, soit un reste de
 * `kill -9`. Bloquer sur ce second cas condamnerait l'ecran jusqu'au prochain run ; on
 * previent, on ne barre pas. C'est la meme prudence que le bloc de suivi.
 */
export type EtatCollecte =
  | { kind: "inactif" }
  | { kind: "pilote"; departement: string; phase: string | null }
  | { kind: "orphelin"; departement: string; phase: string | null };

function phrasePhase(phase: string | null): string {
  return phase === null ? "" : ` — phase ${echapperHtml(phase)}`;
}

/**
 * Le bandeau porte par les ecrans qui montrent des chiffres qu'un run est en train de
 * changer. Rendu au meme endroit sur les trois ecrans : c'est ce qui permet de le
 * reconnaitre sans le lire.
 */
export function banniereRun(etat: EtatCollecte, consequence: string): string {
  if (etat.kind === "inactif") return "";
  if (etat.kind === "pilote") {
    return `<p class="avis"><strong>Run en cours sur le departement ${echapperHtml(etat.departement)}</strong>${phrasePhase(etat.phase)}.
${echapperHtml(consequence)}</p>`;
  }
  return `<p class="avis">Un run est marque « en cours » sur le departement ${echapperHtml(etat.departement)}${phrasePhase(etat.phase)},
sans etre pilote depuis cette interface — un <code>annuaire run</code> dans un terminal, ou un reste
d'interruption brutale. ${echapperHtml(consequence)}</p>`;
}
