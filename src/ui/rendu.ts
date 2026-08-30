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

export function pourcent(numerateur: number, denominateur: number): string {
  if (denominateur === 0) return "—";
  return `${((numerateur / denominateur) * 100).toFixed(1).replace(".", ",")} %`;
}

export type Onglet = "synthese" | "revue" | "export";

export type OptionsPage = {
  titre: string;
  onglet: Onglet;
  departement: string;
  contenu: string;
  version: string;
};

export function page(options: OptionsPage): string {
  const onglet = (cible: Onglet, chemin: string, libelle: string): string =>
    `<a href="${chemin}?departement=${encodeURIComponent(options.departement)}"` +
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
  <strong>Annuaire de la vie associative</strong>
  <nav>
    ${onglet("synthese", "/", "Synthese")}
    ${onglet("revue", "/revue", "Revue")}
    ${onglet("export", "/export", "Export")}
  </nav>
  <span class="discret">departement ${echapperHtml(options.departement)} · v${echapperHtml(options.version)}</span>
</header>
<main>
${options.contenu}
</main>
<footer class="discret">
  Serveur local : rien de ce qui est affiche ici ne sort de cette machine.
</footer>
</body>
</html>
`;
}

/** Selecteur de departement, rendu en tete des ecrans qui en dependent. */
export function choixDepartement(chemin: string, departements: readonly string[], courant: string): string {
  if (departements.length <= 1) return "";
  const options = departements
    .map(
      (dept) =>
        `<option value="${echapperHtml(dept)}"${dept === courant ? " selected" : ""}>${echapperHtml(dept)}</option>`,
    )
    .join("");
  // Pas de `onchange="..."` : la CSP du serveur interdit le JS en ligne, et c'est elle
  // qui rend l'ecran de revue sur d'afficher des chaines venues d'un site tiers. Un
  // bouton coute un clic et ne demande aucune derogation.
  return `<form method="get" action="${chemin}" class="choix">
  <label>Departement <select name="departement">${options}</select></label>
  <button type="submit">Afficher</button>
</form>`;
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
