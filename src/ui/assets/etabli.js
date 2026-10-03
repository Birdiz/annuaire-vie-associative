// Raccourcis de la carte de relecture (ADR-041) : V valide, R rejette, C corrige.
//
// Facultatifs, et c'est voulu : tout se fait aussi a la souris, et sans JavaScript du
// tout — chaque bouton est un vrai bouton d'un vrai formulaire. Ce fichier ne fait que
// cliquer a la place de la personne. Il est servi depuis cette machine comme htmx : la CSP
// refuse tout script en ligne, et un `hx-on` demanderait d'evaluer du code, ce qu'elle refuse aussi.
"use strict";
document.addEventListener("keydown", function (evenement) {
  if (evenement.ctrlKey || evenement.metaKey || evenement.altKey || evenement.repeat) return;
  var cible = evenement.target;
  // Une lettre tapee dans un champ est une lettre, pas une decision.
  if (cible instanceof HTMLElement && (cible.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(cible.tagName))) return;
  var touche = evenement.key.toLowerCase();
  var bouton = document.querySelector('#atelier [data-raccourci="' + touche + '"]');
  if (!(bouton instanceof HTMLButtonElement) || bouton.disabled) return;
  evenement.preventDefault();
  // C sans valeur saisie ne peut que se faire refuser : on ouvre le champ a la place, et
  // Entree y enverra la correction — c'est le seul bouton de son formulaire.
  var champ = bouton.dataset.champ ? document.getElementById(bouton.dataset.champ) : null;
  if (champ instanceof HTMLInputElement && champ.value.trim() === "") {
    champ.focus();
    return;
  }
  bouton.click();
});

// Apres une decision, le bouton qui avait le focus a disparu avec la carte : le focus
// retombait sur la page, et un lecteur d'ecran n'apprenait rien. On le pose sur ce qui
// vient d'arriver — le refus s'il y en a un, sinon la valeur de la carte suivante.
// L'evenement part des noeuds inseres, pas de la cible du swap : d'ou le `closest`.
document.addEventListener("htmx:afterSwap", function (evenement) {
  var cible = evenement.target;
  var atelier = cible instanceof Element ? cible.closest("#atelier") : null;
  if (atelier === null) return;
  // htmx a pu rendre le focus a un champ du meme id — un refus garde la saisie : on le laisse.
  if (document.activeElement !== null && document.activeElement !== document.body) return;
  // Un par un, dans cet ordre : une liste de selecteurs rendrait le premier du document, et
  // le titre de la file, a gauche, passe avant la carte.
  var choix = [".refus", ".carte-relecture .valeur", ".file-vide h2"];
  for (var i = 0; i < choix.length; i += 1) {
    var suite = atelier.querySelector(choix[i]);
    if (suite instanceof HTMLElement) {
      if (!suite.hasAttribute("tabindex")) suite.setAttribute("tabindex", "-1");
      suite.focus();
      return;
    }
  }
});
