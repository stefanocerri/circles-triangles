#!/bin/sh
# Doppio clic: scarica dal sito i font dell'ultima cattura in ~/Downloads, li installa e trova i più simili che hai.
cd "$(dirname "$0")"
JSON="$(ls -t "$HOME"/Downloads/h2f-*.json 2>/dev/null | head -1)"
if [ -z "$JSON" ]; then echo "Nessuna cattura h2f-*.json in Download: usa 'Cattura e scarica .json' nell'estensione."; read -r _; exit 1; fi
echo "Cattura: $JSON"
./fonts.sh "$JSON"
echo; echo "Fatto. Riavvia Figma e trascina di nuovo questo .json nel plugin. Premi Invio per chiudere."; read -r _
