/**
 * Mode d'emploi, a l'ecran.
 *
 * **Pas dans le README.** Celui-ci s'adresse a qui clone le depot : il parle de `npm`, de
 * CSP, de bundle et renvoie a des ADR. La personne qui utilise l'outil, elle, a
 * double-clique sur un executable et regarde un navigateur — elle n'ira jamais lire un
 * fichier Markdown sur une forge. Le mode d'emploi doit etre a l'endroit ou elle est.
 *
 * Le cout est un ecran de texte statique, sans requete ni dependance : le poids du bundle
 * ne bouge pas de facon mesurable, et c'est ce qui rendait l'ajout discutable.
 *
 * **Aucune reference interne** — ni ADR, ni numero de paragraphe du brief, ni nom de
 * table. Les seules references sont legales, parce qu'elles designent un texte que le
 * lecteur peut aller lire.
 *
 * Le texte rendu porte ses accents : la regle du projet les interdit dans les
 * identifiants, pas dans ce qui s'affiche.
 */

import { echapperHtml } from "../rendu.ts";

export type DonneesAide = {
  /** Ou l'outil ecrit sur cette machine. Affiche parce que c'est une question courante. */
  dataDir: string;
  /** Le departement affiche, pour que les liens ramenent la ou on etait. */
  departement: string;
};

export function ecranAide(donnees: DonneesAide): string {
  const dept = encodeURIComponent(donnees.departement);

  return `<h2>Mode d'emploi</h2>

<p class="intro">Cet outil constitue <strong>l'annuaire des associations d'un département</strong>.
Il part de deux fichiers publics — le registre national des associations et l'annuaire de
l'administration — puis va lire les sites des mairies du département pour y trouver les adresses
et les téléphones des associations. Chaque ligne produite porte l'adresse de la page où elle a été
lue, la date de lecture et une note de confiance : vous pouvez toujours remonter à la source.</p>

<p class="discret">Ce qu'il ne fait pas : envoyer des messages, consulter les réseaux sociaux, ni
transmettre quoi que ce soit à l'éditeur de l'outil.</p>

<h2>Les cinq étapes</h2>

<ol class="marche">
  <li>
    <h3>Renseigner l'URL de contact — une fois pour toutes</h3>
    <p>Chaque page visitée reçoit l'adresse d'une page où vous joindre, pour qu'un webmestre de
    mairie puisse vous écrire s'il a une question. <strong>Sans elle, rien n'est collecté</strong> :
    ce n'est pas un réglage, c'est une condition. Une page « contact » de votre collectivité convient.</p>
    <p class="discret">Écran <a href="/?departement=${dept}">Synthèse</a>, premier bloc.</p>
  </li>

  <li>
    <h3>Choisir le département</h3>
    <p>La barre grise, en haut de chaque écran. Tapez le code — <code>35</code>,
    <code>2A</code> en Corse, <code>971</code> outre-mer — puis « Ouvrir ». Un département encore
    jamais collecté s'ouvre vide, et la barre le dit : c'est normal, l'étape suivante le remplira.</p>
    <p class="discret">Trois départements restent hors de portée : le 57, le 67 et le 68. Le droit
    local d'Alsace-Moselle place leurs associations dans un autre registre, que cet outil ne lit pas.</p>
  </li>

  <li>
    <h3>Lancer la collecte, et la laisser travailler</h3>
    <p>Bouton « Lancer le run complet ». <strong>Comptez plusieurs heures</strong>, parfois une
    journée sur un gros département.</p>
    <p>Cette lenteur est voulue et ne se règle pas : l'outil attend <strong>deux secondes entre
    deux visites d'un même site</strong>, pour ne pas peser sur des serveurs de mairie qui n'ont
    rien demandé. Aller plus vite reviendrait à se faire bloquer, et à le mériter.</p>
    <p>Vous pouvez fermer la fenêtre, éteindre le poste, revenir demain : <strong>tout reprend où
    cela s'était arrêté</strong>. Rien n'est perdu et rien n'est refait deux fois.</p>
  </li>

  <li>
    <h3>Relire ce dont l'outil n'est pas sûr</h3>
    <p>Écran <a href="/revue?departement=${dept}">Revue</a>. On y trouve ce que l'outil n'a pas su
    trancher seul, <strong>les cas les moins sûrs en premier</strong> — c'est là que votre lecture
    apporte quelque chose. Chaque carte affiche ce qui a fait baisser la note, et un lien vers la
    page où la valeur a été lue : c'est ce lien qu'il faut ouvrir pour vérifier.</p>
    <p class="discret">Cette étape n'est pas obligatoire. L'export fonctionne sans ; la revue
    améliore le fichier, elle ne le conditionne pas.</p>
  </li>

  <li>
    <h3>Exporter le fichier</h3>
    <p>Écran <a href="/export?departement=${dept}">Export</a>. Vous obtenez un fichier CSV, qui
    s'ouvre dans un tableur. Le « score minimum » filtre sur la confiance : <code>0.6</code> est un
    point de départ raisonnable, un champ vide sort tout, y compris ce dont l'outil doute.</p>
  </li>
</ol>

<h2>Avant de vous servir du fichier</h2>

<p>C'est la partie à ne pas sauter, et elle tient en une phrase :
<strong>ce fichier contient des données personnelles, et vous en êtes responsable</strong> — pas
l'éditeur de l'outil. C'est la conséquence directe du fait que tout se passe sur votre machine :
c'est vous qui collectez.</p>

<p>Trois obligations concrètes :</p>

<ul class="obligations">
  <li><strong>Informer les personnes concernées.</strong> Vous n'avez pas recueilli ces données
  auprès d'elles mais sur des sites publics. L'article 14 du RGPD vous oblige alors à les informer,
  dans un délai d'un mois, ou dès votre première communication avec elles si elle vient avant.</li>

  <li><strong>Lire la colonne <code>regime</code> du fichier.</strong> <code>generique</code>
  désigne une adresse de fonction — <code>contact@</code>, <code>mairie@</code> ;
  <code>nominatif</code> une adresse qui identifie une personne —
  <code>prenom.nom@</code> ; <code>indetermine</code> un cas que l'outil a refusé de trancher
  plutôt que de deviner. Ces trois cas n'appellent pas les mêmes précautions.</li>

  <li><strong>Ce n'est pas un fichier de prospection.</strong> L'outil n'envoie aucun message et ne
  prépare pas de campagne. S'en servir pour démarcher est un autre traitement, avec ses propres
  règles, et il ne vous est pas fourni avec.</li>
</ul>

<p>Si une personne demande à être effacée : le bouton <strong>« Oublier »</strong> de l'écran de
revue. Il supprime la donnée, efface la copie de la page gardée en cache, et inscrit une exclusion
pour qu'elle ne revienne pas à la collecte suivante — sans quoi effacer ne durerait que jusqu'à la
collecte d'après.</p>

<h2>Questions courantes</h2>

<dl class="faq">
  <dt>Rien ne bouge depuis vingt minutes. C'est bloqué ?</dt>
  <dd>Probablement pas. Deux secondes entre chaque visite d'un même site, sur des milliers de
  pages, cela fait des heures où l'écran avance à peine. La barre de progression et le compteur de
  travaux de l'écran Synthèse disent ce qui se passe réellement.</dd>

  <dt>Mon département n'affiche que des zéros.</dt>
  <dd>Il n'a jamais été collecté. La barre du haut l'indique. Lancez la collecte.</dd>

  <dt>Où sont mes données ?</dt>
  <dd>Dans <code>${echapperHtml(donnees.dataDir)}</code>, sur cette machine. On y trouve la base,
  le cache des pages lues et le journal. Supprimer ce dossier efface tout le travail.</dd>

  <dt>Est-ce que quelque chose sort de mon poste ?</dt>
  <dd>Vers les sites des mairies, oui — c'est le travail de l'outil, et chaque visite annonce votre
  URL de contact. Vers l'éditeur de l'outil, jamais : aucune mesure d'usage, aucun envoi.</dd>

  <dt>Et les numéros de portable ?</dt>
  <dd>Écartés par défaut. Un 06 publié sur le site d'une commune est presque toujours la ligne
  personnelle d'un bénévole, pas le téléphone d'un local associatif. Une case permet de les
  conserver, avec ce que cela engage ; elle se remet à zéro à chaque lancement de l'outil.</dd>

  <dt>Je veux un deuxième département.</dt>
  <dd>La barre du haut : tapez son code, puis lancez la collecte. Sachez que chaque département
  relit le registre national en entier — 1,25 Go à chaque fois — car il n'est pas conservé sur
  votre disque.</dd>

  <dt>Puis-je collecter la France entière d'un coup ?</dt>
  <dd>Non, et ce n'est pas un oubli. À deux secondes par site et environ 35 000 communes, une telle
  collecte durerait plusieurs jours sans interruption. L'outil travaille département par
  département.</dd>
</dl>
`;
}
