"use strict";
/* Configuration de AGOA ML (boîte mail partagée). Les feuilles et champs Ragic sont retrouvés par leur LIBELLÉ exact
   (schéma de l'API Ragic) : ne pas renommer un champ dans Ragic sans modifier ce fichier.
   Les chemins des feuilles créées après coup (…/mails/N) sont à ajuster ici ou par la variable AGOA_ML_PATHS
   (JSON : {"collaborateurs":"/mails/3", …}). */
const paths = (() => { try { return JSON.parse(process.env.AGOA_ML_PATHS || "{}"); } catch (e) { return {}; } })();
const P = (name, def) => paths[name] || def;

module.exports = {
  appName: "AGOA ML",
  colonneParDefaut: "To do",
  mailbox: "agence@remithollet.fr",
  allowedDomain: "remithollet.fr",
  aliases: ["etudes@remithollet.fr", "comptabilite@remithollet.fr", "secretariat@remithollet.fr"],
  googleScopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"],
  /* valeurs de la liste « Statut » de la feuille Mails */
  statutsRagic: { nouveau: "Nouveau", urgent: "Urgent", atraiter: "A traiter", attente: "En attente", avalider: "A valider", traite: "Traité" },
  gmailQuery: "in:inbox OR in:sent",
  syncMs: 60000,
  ragic: {
    apname: "agoa",
    hosts: ["www.ragic.com", "eu2.ragic.com", "na3.ragic.com", "ap5.ragic.com"],
    pollMs: 8000,
    boolTrue: "Yes", boolFalse: "",
    sheets: {
      mails: { path: P("mails", "/mails/2"), key: "id", fields: {
        id: { label: "Thread ID" }, objet: { label: "Objet" }, expediteur: { label: "Expéditeur" }, expEmail: { label: "E-mail expéditeur", optional: true },
        alias: { label: "Alias destinataire" }, imm: { label: "Immeuble" }, op: { label: "Opération" }, opRid: { label: "ID opération Ragic" },
        phase: { label: "Phase concernée" }, colonne: { label: "Colonne", optional: true }, statut: { label: "Statut" }, assigne: { label: "Pris en charge par" },
        relance: { label: "Relance" }, attenteDepuis: { label: "En attente depuis" }, nb: { label: "Nb messages" },
        dernier: { label: "Dernier message" }, dernierExp: { label: "Dernier expéditeur" }, lien: { label: "Lien Gmail" }, modifiePar: { label: "Modifié par" },
        attendu: { label: "Réponses attendues" }, notes: { label: "Notes" }, journal: { label: "Journal" }, rapproches: { label: "Fils rapprochés" }
      } },
      collaborateurs: { path: P("collaborateurs", "/mails/3"), key: "nom", fields: {
        nom: { label: "Nom" }, email: { label: "E-mail" }, fonction: { label: "Fonction" }, valideur: { label: "Valideur" }, actif: { label: "Actif" } } },
      phases: { path: P("phases", "/mails/4"), key: "libelle", fields: { ordre: { label: "Ordre" }, libelle: { label: "Libellé" }, actif: { label: "Actif" } } },
      statutsPhase: { path: P("statutsPhase", "/mails/5"), key: "libelle", fields: {
        ordre: { label: "Ordre" }, libelle: { label: "Libellé" }, couleur: { label: "Couleur" }, systeme: { label: "Statut système" } } },
      alias: { path: P("alias", "/mails/6"), key: "adresse", fields: { adresse: { label: "Adresse" }, collaborateur: { label: "Collaborateur par défaut" } } },
      avancement: { path: P("avancement", "/mails/7"), key: "cle", fields: {
        cle: { label: "Clé" }, codeOp: { label: "Code opération" }, imm: { label: "Immeuble" }, phase: { label: "Phase" }, statutPhase: { label: "Statut de phase" },
        date: { label: "Date" }, par: { label: "Mis à jour par" }, thread: { label: "Fil (Thread ID)" }, opRid: { label: "ID opération Ragic" } } },
      regles: { path: P("regles", "/mails/8"), key: null, fields: {
        phase: { label: "Phase" }, statutPhase: { label: "Statut de phase" }, champ: { label: "Champ OPERATIONS visé" },
        champId: { label: "ID du champ", optional: true }, action: { label: "Action" }, valeur: { label: "Valeur" }, actif: { label: "Actif" } } },
      colonnes: { path: P("colonnes", "/mails/10"), key: "libelle", optional: true, fields: {
        ordre: { label: "Ordre" }, libelle: { label: "Libellé" }, couleur: { label: "Couleur" }, actif: { label: "Actif" }, defaut: { label: "Par défaut" } } },
      notifications: { path: P("notifications", "/mails/9"), key: "cle", fields: {
        cle: { label: "Clé" }, pour: { label: "Pour" }, de: { label: "De" }, date: { label: "Date" }, texte: { label: "Texte" }, thread: { label: "Fil (Thread ID)" }, lue: { label: "Lue" } } }
    },
    /* feuilles existantes en lecture : identifiants connus (le schéma est relu si la clé le permet) */
    immeubles: { path: "/agoa/3", fields: { code: { label: "code" }, syndic: { label: "syndic" }, emailGest: { label: "E-mail gestionnaire", optional: true }, emailAssist: { label: "E-mail assistant(e)", optional: true } } },
    operations: { path: "/operations/10", code: 1000295, imm: 1000278, indice: 1000279, statut: 1003061, architecte: 1001784, suivi: 1001758, avancement: 1001618 },
    syndics: { path: "/agoa/1", fields: { nom: { label: "Nom", optional: true }, email: { label: "Email" } } }
  }
};
