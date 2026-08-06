# Prix carburants

Suivez le prix du carburant que vous utilisez dans les stations-service
proches de chez vous, directement dans Gladys : un appareil par station, un
historique de prix, et des scènes qui peuvent vous prévenir quand le plein
devient intéressant.

Les données proviennent de l'**open data officiel**. Aucun compte, aucune clé
d'API, aucun abonnement.

| Pays   | Source                                                                                             |
| ------ | -------------------------------------------------------------------------------------------------- |
| France | [prix-carburants.gouv.fr](https://www.prix-carburants.gouv.fr/rubrique/opendata/) (licence Etalab) |

D'autres pays pourront être ajoutés dans de prochaines versions : l'intégration
est construite autour d'un « fournisseur » par pays.

## Ce que vous obtenez

Pour **chaque station que vous ajoutez**, un appareil avec deux mesures :

- **Prix** — le prix au litre du carburant choisi, en euros. L'historique est
  conservé : Gladys trace la courbe du prix dans le temps.
- **Dernière mise à jour** — la date à laquelle la station a déclaré ce prix
  (le flux national est rafraîchi toutes les 10 minutes environ, mais une
  station donnée ne change pas ses prix tous les jours).

L'adresse, la marque, les coordonnées GPS et la distance au code postal sont
enregistrées dans les paramètres de l'appareil.

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Choisissez votre **pays** (France pour l'instant).
3. Renseignez votre **code postal** (5 chiffres en France, par exemple
   `35000`). C'est autour de lui que les stations sont cherchées.
4. Réglez le **rayon de recherche** : `0` ne garde que les stations du code
   postal lui-même, `10` km élargit aux communes voisines.
5. Cochez le ou les **types de carburant** qui vous intéressent : Gazole,
   SP95, SP98, E10, E85, GPLc.
6. Enregistrez.

Le bouton **Prévisualiser les stations proches** affiche immédiatement ce que
la recherche renvoie, avec les prix actuels — pratique pour ajuster le code
postal ou le rayon avant d'ajouter quoi que ce soit.

## Ajouter des stations

Ouvrez l'onglet **Découverte** : les stations trouvées y apparaissent, une
entrée par station **et** par carburant sélectionné, par exemple
« TotalEnergies - Rennes - Gazole » et « TotalEnergies - Rennes - SP98 ».
Cliquez sur **Ajouter** pour celles que vous voulez suivre : une seule,
plusieurs, ou toutes.

Seules les combinaisons réellement disponibles sont proposées : une station
qui ne vend pas de GPLc n'apparaît pas dans la liste GPLc.

Une fois ajoutée, la station publie son prix immédiatement, puis à chaque
rafraîchissement (une fois par heure par défaut). Le bouton **Rafraîchir les
prix maintenant** force une lecture sans attendre.

## Supprimer des stations

Ouvrez l'appareil dans **Réglages → Appareils**, puis **Supprimer**.
L'intégration cesse aussitôt de l'interroger. La station reste visible dans
l'onglet **Découverte** tant qu'elle correspond à votre recherche : vous
pouvez la ré-ajouter plus tard.

Supprimer un carburant d'une station n'affecte pas les autres : « Rennes -
Gazole » et « Rennes - SP98 » sont deux appareils indépendants.

## Changer de carburant plus tard

Un appareil Gladys conserve les mesures avec lesquelles il a été créé. Le
carburant fait donc partie de l'identité de l'appareil : si vous cochez un
carburant supplémentaire dans la configuration, de **nouvelles** entrées
apparaissent dans l'onglet Découverte, et vos appareils existants continuent
de fonctionner sans être modifiés. Supprimez ceux dont vous n'avez plus
besoin.

## Idées de scènes

- Recevoir une notification quand le prix du gazole de votre station passe
  sous un seuil.
- Comparer deux stations sur le tableau de bord avant de partir faire le
  plein.
- Enregistrer le prix moyen du mois grâce à l'historique.

## Dépannage

**Aucune station dans l'onglet Découverte.** Vérifiez le code postal (5
chiffres en France) et augmentez le rayon de recherche. Le bouton
**Prévisualiser les stations proches** affiche le message d'erreur exact.

**Le prix ne se met plus à jour.** Une station peut disparaître temporairement
du flux national (travaux, fermeture). Le dernier prix connu reste affiché ;
consultez les logs de l'intégration, qui indiquent les stations manquantes.

**Un prix vide.** La station ne déclare pas ce carburant en ce moment.
L'intégration conserve alors la dernière valeur connue plutôt que de trouer la
courbe.

**Nombre de stations limité.** Le réglage **Nombre maximum de stations** borne
la liste de découverte (20 par défaut, 50 au maximum). En ville dense,
baissez-le et réduisez le rayon.

## Données et licence

Les données sont publiées par le ministère de l'Économie sous
[licence Etalab](https://www.etalab.gouv.fr/licence-ouverte-open-licence).
L'intégration interroge le
[jeu de données « flux instantané »](https://data.economie.gouv.fr/explore/dataset/prix-des-carburants-en-france-flux-instantane-v2/)
et ne récupère que les stations autour de votre code postal.
