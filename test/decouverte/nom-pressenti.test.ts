import { test } from "node:test";
import assert from "node:assert/strict";

import { nomPressenti } from "../../src/decouverte/nom-pressenti.ts";
import { MOTIFS_NOM } from "../../src/normalisation/classification.ts";
import { normaliserNom } from "../../src/texte.ts";

/**
 * L'heuristique qui lit un nom dans le bloc DOM (ADR-033).
 *
 * Ce qu'on defend ici tient en deux exigences opposees, et c'est tout le probleme : elle
 * doit ramasser assez de noms pour que le fichier serve, et assez peu de bruit pour qu'on
 * puisse s'y fier. Les tests de rejet valent donc autant que ceux d'acceptation — et un
 * test verrouille explicitement le filtre trop zele.
 */

test("le nom est le segment le plus proche du contact, en remontant", () => {
  const bloc = "Associations sportives — Tennis Club de Bruzou — contact@tennis-bruzou.example";
  const trouve = nomPressenti([bloc], "contact@tennis-bruzou.example");

  // La rubrique est plus loin ; c'est le club qui porte l'adresse.
  assert.equal(trouve?.nom, "Tennis Club de Bruzou");
  assert.equal(trouve?.source, "bloc:avant");
});

test("un contact en tete de bloc regarde devant lui", () => {
  const bloc = "contact@judo-bruzou.example | Judo Club de Bruzou";
  const trouve = nomPressenti([bloc], "contact@judo-bruzou.example");

  assert.equal(trouve?.nom, "Judo Club de Bruzou");
  assert.equal(trouve?.source, "bloc:apres");
});

test("une empreinte absente du texte retombe sur la position du contact efface", () => {
  // C'est le cas d'un `mailto:` : l'empreinte est le `href`, que le texte rendu ne
  // contient pas. Sans ce repli, aucun contact declare par un lien ne serait jamais nomme.
  const bloc = "Comite des fetes — ecrire au comite";
  const avecTexte = "Comite des fetes — contact@fetes.example";

  assert.equal(nomPressenti([avecTexte], "mailto:contact@fetes.example")?.nom, "Comite des fetes");
  // Et sans aucun contact reperable, on ne devine pas.
  assert.equal(nomPressenti([bloc], "mailto:contact@fetes.example"), undefined);
});

test("le bloc suivant prend le relais quand le premier ne donne rien", () => {
  const etroit = "contact@club.example";
  const large = "Amicale Laique de Bruzou : contact@club.example";

  assert.equal(nomPressenti([etroit, large], "contact@club.example")?.nom, "Amicale Laique de Bruzou");
});

test("on n'examine que les deux blocs les plus etroits", () => {
  // Le troisieme est typiquement un `article` : il porte le titre de la page entiere, et
  // le coller a chacun des vingt contacts qu'elle contient serait pire que ne rien mettre.
  const contextes = ["contact@club.example", "contact@club.example", "Vie Associative de Bruzou : contact@club.example"];
  assert.equal(nomPressenti(contextes, "contact@club.example"), undefined);
});

test("tous les contacts du bloc sont effaces, pas seulement celui qu'on nomme", () => {
  // Sans cela, le numero deviendrait le segment le plus proche, donc le nom.
  const bloc = "Tennis Club — 02 99 00 00 00 — contact@tennis.example";
  assert.equal(nomPressenti([bloc], "contact@tennis.example")?.nom, "Tennis Club");
});

test("le mobilier de page n'est pas un nom de structure", () => {
  for (const bloc of [
    "Contact : contact@mairie.example",
    "Téléphone : contact@mairie.example",
    "Nous écrire — contact@mairie.example",
    "Mairie de Bruzou — contact@mairie.example",
    "Secrétariat, contact@mairie.example",
    "Contacts | contact@mairie.example",
    "35 130 Moussé | contact@mairie.example",
  ]) {
    assert.equal(nomPressenti([bloc], "contact@mairie.example"), undefined, bloc);
  }
});

test("le libelle d'un lien ne devient pas le nom de la structure", () => {
  // Cas trouve par le test de bout en bout, et pas par l'imagination : dans une cellule
  // de tableau, « <a href="mailto:...">ecrire</a> » place le texte du lien **entre** le
  // nom et le contact. Sans cette regle, c'est lui le segment le plus proche.
  const bloc = "Club de Bruz | ecrire | 02 99 00 11 22";
  assert.equal(nomPressenti([bloc], "mailto:club@asso.example")?.nom, "Club de Bruz");

  for (const libelle of ["contacter", "envoyer", "voir", "en savoir plus"]) {
    assert.equal(nomPressenti([`Club | ${libelle} | contact@x.example`], "contact@x.example")?.nom, "Club");
  }
});

test("aucun motif de structure n'est masque par le mobilier de page", () => {
  // Le garde-fou par construction. « accueil » est du mobilier, « accueil de loisirs » est
  // une structure — et c'est celle qu'une collectivite cherche en premier, celle que le RNA
  // ne connait jamais. Ce test rougit si un mot ajoute au mobilier en masque un autre.
  for (const [motif] of MOTIFS_NOM) {
    const bloc = `${motif} du Ru | contact@x.example`;
    assert.equal(
      nomPressenti([bloc], "contact@x.example")?.nom,
      `${motif} du Ru`,
      `« ${motif} » est masque par le filtre de mobilier`,
    );
  }
});

test("une puce de navigation n'entre pas dans le nom", () => {
  // L'adaptateur DOM laisse passer les ornements de liste ; « >> Ecole Elementaire » est
  // un nom precede d'un chevron, pas un nom qui commence par un chevron.
  assert.equal(
    nomPressenti([">> École Élémentaire Publique | contact@x.example"], "contact@x.example")?.nom,
    "École Élémentaire Publique",
  );
});

test("« Accueil » seul reste un lien de navigation", () => {
  // Rejete comme segment entier, jamais en prefixe : c'est toute la difference entre le
  // menu d'un site et le nom d'une structure.
  assert.equal(nomPressenti(["Accueil | contact@x.example"], "contact@x.example"), undefined);
  assert.equal(
    nomPressenti(["Accueil périscolaire de Bruz | contact@x.example"], "contact@x.example")?.nom,
    "Accueil périscolaire de Bruz",
  );
});

test("le nom d'une personne n'est pas le nom d'une structure", () => {
  // Trouve sur un departement reel : 43 lignes portaient « Mr X » et une adresse
  // personnelle. Le profil simple n'a pas de colonne `regime` — une telle ligne y
  // presenterait une personne physique comme une structure.
  // Noms inventes : aucune donnee collectee n'entre dans le depot.
  for (const bloc of [
    "Mr Michel DURANDEL | durandel.m6@free.example",
    "Mme MARTINOT Nathalie | n.martinot@free.example",
    "M. Durandel | durandel@free.example",
  ]) {
    assert.equal(nomPressenti([bloc], "durandel.m6@free.example"), undefined, bloc);
  }
  // Mais « Amicale des Meuniers » n'est pas une civilite deguisee.
  assert.equal(
    nomPressenti(["Amicale des Meuniers | contact@x.example"], "contact@x.example")?.nom,
    "Amicale des Meuniers",
  );
});

test("une adresse postale n'est pas un nom de structure", () => {
  // Trouve sur un departement reel : « 35370 Argentré-du-Plessis » avait fusionne les
  // adresses de trois personnes distinctes sous un faux nom commun.
  for (const bloc of [
    "1 place des Croisettes | contact@x.example",
    "35250 Andouillé-Neuville | contact@x.example",
    "12 rue de la Mairie | contact@x.example",
    "Route de Rennes | contact@x.example",
  ]) {
    assert.equal(nomPressenti([bloc], "contact@x.example"), undefined, bloc);
  }
  // Un chiffre en tete condamne le segment, et ce n'est pas une precaution excessive :
  // sur le departement 88, 22 des 965 lignes livrees s'appelaient « 8 Lauterupt - » ou
  // « 12 personnes ». La regle admettait auparavant le chiffre pour ne pas perdre un
  // hypothetique « 4L Trophy » — les donnees ont tranche, l'hypothese ne s'est jamais
  // presentee et les vingt-deux faux noms si.
  assert.equal(nomPressenti(["4L Trophy Bruz | contact@x.example"], "contact@x.example"), undefined);
  assert.equal(
    nomPressenti(["Les Amis de la Rue Verte | contact@x.example"], "contact@x.example")?.nom,
    "Les Amis de la Rue Verte",
  );
});

test("un fragment de phrase se reconnait a sa minuscule initiale", () => {
  // Le signal le plus rentable mesure sur un departement reel : 16 % des noms retenus
  // commencaient par une minuscule, et c'etaient tous des fragments. Ni la longueur ni le
  // vocabulaire ne les separaient — la casse, oui.
  for (const bloc of [
    "bouquets et compositions végétales | contact@x.example",
    "participation au suivi de la scolarité | contact@x.example",
    "vendredi et dimanche toute la journée | contact@x.example",
  ]) {
    assert.equal(nomPressenti([bloc], "contact@x.example"), undefined, bloc);
  }
  // L'article elide reste admis : le rejeter couterait trop cher.
  assert.equal(
    nomPressenti(["l'Amicale des Meuniers | contact@x.example"], "contact@x.example")?.nom,
    "l'Amicale des Meuniers",
  );
});

test("une URL n'est pas un nom de structure", () => {
  for (const bloc of [
    "//www.baguerpican.fr/wp-content/uploads/LOGO.png | contact@x.example",
    "betton.echecs35.fr | contact@x.example",
    "monsite.fr | contact@x.example",
  ]) {
    assert.equal(nomPressenti([bloc], "contact@x.example"), undefined, bloc);
  }
});

test("les rebuts trouves sur un departement reel ne passent plus", () => {
  // Chacun de ces noms a ete livre au client dans l'export du 88. Ils sont ici pour ne
  // plus revenir.
  for (const c of [
    "E-mail",
    "E-Mail",
    "8 Lauterupt -",
    "12 personnes",
    "2 Bas de Raumont -",
    "Plus d&rsquo",
    ". Nous procéderons à la mise à jour de l&rsquo",
    "mailo.com",
  ]) {
    assert.equal(nomPressenti([`${c} | contact@x.example`], "contact@x.example"), undefined, c);
  }
});

test("la ponctuation d'ornement se retire des deux bouts", () => {
  // « Elevage de bovins - » venait d'une cellule de tableau : le tiret n'appartient pas
  // au nom, et le garder faisait passer l'outil pour negligent. Cet exemple-la est
  // desormais refuse pour une autre raison — c'est une exploitation, pas une association
  // — d'ou le nom de remplacement : ce test ne parle que de la ponctuation.
  assert.equal(
    nomPressenti(["Ecole de musique - | contact@x.example"], "contact@x.example")?.nom,
    "Ecole de musique",
  );
});

test("une phrase adressee au lecteur n'est pas un nom", () => {
  for (const bloc of [
    "Vous pouvez nous joindre à contact@club.example",
    "Cliquez ici pour écrire à contact@club.example",
    "Permanence le mardi, contact@club.example",
  ]) {
    assert.equal(nomPressenti([bloc], "contact@club.example"), undefined, bloc);
  }
});

test("un nom legitime portant « pour », « de » ou « la » n'est pas rejete", () => {
  // Verrou contre le filtre de prose trop zele : c'est lui qui viderait le profil simple
  // sans que personne ne comprenne pourquoi.
  const bloc = "Association pour la sauvegarde du patrimoine — contact@patrimoine.example";
  assert.equal(
    nomPressenti([bloc], "contact@patrimoine.example")?.nom,
    "Association pour la sauvegarde du patrimoine",
  );
});

test("l'heuristique rejette plutot que de tronquer", () => {
  const trop_long = `${"Association ".repeat(12)}de Bruzou`;
  assert.equal(nomPressenti([`${trop_long} — contact@x.example`], "contact@x.example"), undefined);

  // Trop court, aucune lettre, majorite de chiffres : trois facons de ne rien apprendre.
  assert.equal(nomPressenti(["AB — contact@x.example"], "contact@x.example"), undefined);
  assert.equal(nomPressenti(["--- — contact@x.example"], "contact@x.example"), undefined);
  assert.equal(nomPressenti(["12 rue 75011 — contact@x.example"], "contact@x.example"), undefined);
});

test("les accents de la page sont gardes dans le nom, et perdus dans sa forme normalisee", () => {
  const trouve = nomPressenti(["Théâtre des Grandes Landes — contact@theatre.example"], "contact@theatre.example");

  assert.equal(trouve?.nom, "Théâtre des Grandes Landes");
  assert.equal(trouve?.normalise, "theatre des grandes landes");
  // Les deux colonnes doivent rester coherentes : c'est `normalise` qui sert de cle de
  // groupe a l'export, et `nom` qui s'affiche.
  assert.equal(trouve?.normalise, normaliserNom(trouve?.nom ?? ""));
});

test("les cellules d'un tableau, collees par des espaces, se separent quand meme", () => {
  // L'adaptateur DOM joint les cellules voisines avec des espaces, pas avec une balise :
  // sans la regle des trois espaces, la ligne entiere ferait un seul segment.
  const bloc = "Club de Bruzou    02 99 00 00 00    contact@club.example";
  assert.equal(nomPressenti([bloc], "contact@club.example")?.nom, "Club de Bruzou");
});

/**
 * Les valeurs ci-dessous ont toutes ete livrees a un client, dans le fichier de la Loire
 * ou celui des Vosges. C'est leur seule justification : aucune n'a ete imaginee.
 */
test("ce que le client a refuse ne ressort pas", () => {
  for (const bloc of [
    "Dans tous les cas contact@x.example",
    "Entrez en contact avec l'association en ecrivant a contact@x.example",
    "A partir du 1er decembre 2025 contact@x.example",
    "Retrouvez toutes les informations ICI contact@x.example",
    "Cette rubrique est au service des associations. contact@x.example",
    "Toutes demandes doivent etre adressees par mail a la mairie contact@x.example",
    "Facebook | contact@x.example",
    "Site internet | contact@x.example",
    "Telecopie | contact@x.example",
    "Page brouillon | contact@x.example",
    "Directrice | contact@x.example",
    "Associations / Sports contact@x.example",
    "Garage Pupier contact@x.example",
    "Boulangerie Vericel-Guyot contact@x.example",
    "GAEC Jacquet Elevage contact@x.example",
    "CS 10 032 - 42160 Andrezieux-Boutheon contact@x.example",
    "France contact@x.example",
    "De 8h30 a 12h contact@x.example",
    "Organisation de bourses aux vetements contact@x.example",
  ]) {
    assert.equal(nomPressenti([bloc], "contact@x.example"), undefined, bloc);
  }
});

test("ce qui nomme vraiment une structure passe toujours", () => {
  // Le risque du filtre est ici, pas ailleurs : un filtre trop zele viderait le profil
  // simple sans que personne ne comprenne pourquoi.
  for (const [bloc, attendu] of [
    ["Tennis Club de Bruzou — contact@x.example", "Tennis Club de Bruzou"],
    ["Accueil de loisirs Les Petites Mains contact@x.example", "Accueil de loisirs Les Petites Mains"],
    ["Association pour la sauvegarde du patrimoine contact@x.example", "Association pour la sauvegarde du patrimoine"],
    ["AUTOUR DU LIVRE contact@x.example", "AUTOUR DU LIVRE"],
    ["LES AMIS DU VIEUX BOUTHEON contact@x.example", "LES AMIS DU VIEUX BOUTHEON"],
    ["Amicale des secretaires contact@x.example", "Amicale des secretaires"],
  ] as const) {
    assert.equal(nomPressenti([bloc], "contact@x.example")?.nom, attendu, bloc);
  }
});

test("le nom de la commune n'est pas le nom d'une structure", () => {
  // Il vient du pied de page ou de l'adresse postale. « Deyvillers » nommait dix-neuf
  // contacts dans le fichier des Vosges.
  assert.equal(nomPressenti(["Deyvillers mairie@x.example"], "mairie@x.example", "Deyvillers"), undefined);
  // Sans la commune, le filtre ne peut rien affirmer : il ne devine pas.
  assert.equal(nomPressenti(["Deyvillers mairie@x.example"], "mairie@x.example")?.nom, "Deyvillers");
  // Et il ne mange pas ce qui contient le nom de la commune sans s'y reduire.
  assert.equal(
    nomPressenti(["Tennis Club de Deyvillers contact@x.example"], "contact@x.example", "Deyvillers")?.nom,
    "Tennis Club de Deyvillers",
  );
});

test("une region, une rubrique, le nom de la commune : rien de tout cela n'est une structure", () => {
  // « France Grand Est », lu au bas de trente-sept fiches d'un meme annuaire, reunissait
  // trente-sept associations sur une seule ligne du fichier livre.
  for (const [bloc, commune] of [
    ["France Grand Est contact@x.example", undefined],
    ["Associations sportives contact@x.example", undefined],
    ["Associations Patriotiques contact@x.example", undefined],
    ["Services administratifs contact@x.example", undefined],
    // Le pied de page ecrit le nom court, la base le nom complet : l'egalite stricte
    // laissait passer « Plombieres » pour Plombieres-les-Bains.
    ["Plombieres mairie@x.example", "Plombières-les-Bains"],
  ] as const) {
    assert.equal(nomPressenti([bloc], "", commune), undefined, bloc);
  }
});

/**
 * Lot 12 — « il y a toujours des noms ». Le client a refuse les personnes en colonne « nom »,
 * que l'ADR-032 avait choisi de garder : un quart des lignes de ses fichiers de l'Ain et de
 * la Haute-Loire. Les formes ci-dessous sont les leurs, les noms sont inventes.
 */

test("une personne ecartee, c'est la structure de la fiche qui nomme le contact", () => {
  // Le titre de la fiche est dans le meme bloc que le president : quand la personne est
  // refusee, la boucle passe au segment suivant. C'est tout le « chercher la structure ».
  for (const [bloc, attendu] of [
    ["Tennis Club de Bruzou\nAgnès DURANDEL préside cette association\ncontact@x.example", "Tennis Club de Bruzou"],
    ["Judo Club du Ru | Annie DURANDEL | contact@x.example", "Judo Club du Ru"],
    ["Les Amis du Moulin | DURANDEL Gerard | contact@x.example", "Les Amis du Moulin"],
  ] as const) {
    assert.equal(nomPressenti([bloc], "contact@x.example")?.nom, attendu, bloc);
  }
  // Sans structure dans le bloc, rien : une personne n'est pas un nom par defaut.
  assert.equal(nomPressenti(["Annie DURANDEL | contact@x.example"], "contact@x.example"), undefined);
});

test("un libelle de champ separe la structure de la personne", () => {
  for (const [bloc, attendu] of [
    ["SOCIETE de CHASSE Président MARTINOT Paul contact@x.example", "SOCIETE de CHASSE"],
    ["Amicale Laïque Trésorière : contact@x.example", "Amicale Laïque"],
    ["Comité des fêtes - Président contact@x.example", "Comité des fêtes"],
    ["Travaux manuels Président(e) contact@x.example", "Travaux manuels"],
  ] as const) {
    assert.equal(nomPressenti([bloc], "contact@x.example")?.nom, attendu, bloc);
  }
  // Au singulier seulement : le pluriel nomme une structure.
  assert.equal(
    nomPressenti(["Amicale des secrétaires de mairie contact@x.example"], "contact@x.example")?.nom,
    "Amicale des secrétaires de mairie",
  );
});

test("un numero dans un nom ne sort jamais, colle ou non", () => {
  // INVARIANT §4.6 : un 06 colle a la cellule suivante echappait a l'extraction, et
  // finissait dans la colonne « nom ». Numeros de la tranche reservee a la fiction.
  for (const bloc of [
    "Paul DURANDEL - 06 39 98 00 01Albert MARTINOT | contact@x.example",
    "Tennis Club 04 71 00 00 00Bureau | contact@x.example",
    "Orchestre-dHarmonie-de-Bruzou-100083325431850 | contact@x.example",
  ]) {
    const trouve = nomPressenti([bloc], "contact@x.example");
    assert.doesNotMatch(trouve?.nom ?? "", /\d{2}[\s.]?\d{2}/, bloc);
  }
});

test("un jour, un libelle, un lieu-dit, un texte casse ne nomment rien", () => {
  for (const c of [
    "Samedi",
    "Tous les lundis",
    "Samedi-Dimanche-Lundi",
    "Mardi rdv à",
    "Nombre d'adhérents",
    "Pour plus d'informations",
    "Pour tous renseignements",
    "Nom du Président(e)",
    "Son Président",
    "N° de téléphone",
    "Par contact téléphonique",
    "Position GPS",
    "Page Instagram",
    "Renseignement",
    "Réservation par téléphone au",
    "Le Bourg",
    "Hameau du Jardin Public",
    "Z.A. La clé des champs",
    "TÃ©l. Fixe",
    "Comit%C3%A9-Secours-Populaire",
    "Élèves)",
  ]) {
    assert.equal(nomPressenti([`${c} | contact@x.example`], "contact@x.example"), undefined, c);
  }
});

test("les noms du RNA voisins de ces rejets passent toujours", () => {
  // Chacune de ces regles a ete mesuree contre les 49 118 noms du RNA de la base de
  // developpement : ce sont les formes qu'une regle trop large aurait emportees.
  for (const nom of [
    "Sport pour tous",
    "Maison pour tous",
    "Mardi matin",
    "Les Jeudis de Bruzou",
    "Vendredi 13",
    "Le Bourg en fête",
    "Lotissement du Moulin",
    "Culture bretonne (danse",
  ]) {
    assert.equal(nomPressenti([`${nom} | contact@x.example`], "contact@x.example")?.nom, nom, nom);
  }
});

test("quand le bloc ne nomme qu'une personne, c'est le titre de la fiche qui nomme", () => {
  // La carte d'un CMS repandu en Haute-Loire : le titre porte la structure et la
  // presidente, le paragraphe « Domaine : Aines » et « X preside cette association ».
  const bloc = "Domaine de l'association: Aînés\nPaulette DURANDEL préside cette association\nclub@moulin.example";
  const trouve = nomPressenti([bloc], "club@moulin.example", undefined, "CLUB DU MOULIN - DURANDEL Paulette");
  assert.equal(trouve?.nom, "CLUB DU MOULIN");
  assert.equal(trouve?.source, "bloc:titre");
  // Sans titre, la categorie n'est pas un nom de repli.
  assert.equal(nomPressenti([bloc], "club@moulin.example"), undefined);
});

test("le titre ne se lit que si le bloc nommait une personne", () => {
  // Lu partout, il nommait surtout des rubriques — « Nature », « Musique » — sur le 43.
  assert.equal(nomPressenti(["club@x.example"], "club@x.example", undefined, "Musique"), undefined);
  assert.equal(
    nomPressenti(["Annie DURANDEL | club@x.example"], "club@x.example", undefined, "Harmonie du Ru")?.nom,
    "Harmonie du Ru",
  );
  // Un titre qui n'est qu'un libelle ne nomme rien, meme apres une personne.
  assert.equal(nomPressenti(["Annie DURANDEL | club@x.example"], "club@x.example", undefined, "Contact"), undefined);
});

test("une personne coupee en deux cellules reste une personne", () => {
  // « Nom : ROCHE | Prenom : Sylvie » : le nom de famille seul passait pour un sigle.
  assert.equal(
    nomPressenti(["Amicale des Sapeurs-Pompiers\nDURANDEL\nSylvie\n02 99 00 00 00\nclub@x.example"], "club@x.example")?.nom,
    "Amicale des Sapeurs-Pompiers",
  );
});

test("le nom d'une commune voisine ne nomme pas une structure", () => {
  const commune = { nom: "Bruzou", voisines: new Set(["bruzou", "le ru en velay", "vorey"]) };
  for (const c of ["Le Ru", "Le Ru-en-Velay", "Vorey sur Arzon", "Vorey"]) {
    assert.equal(nomPressenti([`${c} | contact@x.example`], "contact@x.example", commune), undefined, c);
  }
  // Un club qui porte le nom d'une commune voisine reste un club.
  assert.equal(
    nomPressenti(["Vorey Tennis Club | contact@x.example"], "contact@x.example", commune)?.nom,
    "Vorey Tennis Club",
  );
});

test("un debut de numero coupe par la cellule suivante ne sort pas non plus dans un nom", () => {
  // INVARIANT §4.6 : « Veronique X au 06 98 » — le reste du numero etait dans la cellule
  // suivante. Separateurs exiges : « La Parole 0702 » est un nom du RNA.
  assert.equal(nomPressenti(["Club du Ru au 06 39 | contact@x.example"], "contact@x.example"), undefined);
  assert.equal(nomPressenti(["La Parole 0702 | contact@x.example"], "contact@x.example")?.nom, "La Parole 0702");
});

test("un texte mal decode ne nomme rien, un nom portugais si", () => {
  assert.equal(nomPressenti(["Annie DURANDÃ‰ | contact@x.example"], "contact@x.example"), undefined);
  assert.equal(nomPressenti(["Amigos de São João | contact@x.example"], "contact@x.example")?.nom, "Amigos de São João");
});
