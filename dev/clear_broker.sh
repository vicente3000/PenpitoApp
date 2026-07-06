#!/usr/bin/env bash
# Limpia los mensajes retenidos de Penpito en el broker Mosquitto.
# Usar antes de una demo para que la app no muestre estado "fantasma".

set -e

BROKER_HOST="${1:-172.20.10.7}"
BROKER_PORT="${2:-1883}"

if ! command -v mosquitto_pub >/dev/null 2>&1; then
  echo "Error: mosquitto_pub no esta instalado. Instala con: brew install mosquitto"
  exit 1
fi

TOPICS=(
  "penpito/kraken/state"
  "penpito/kraken/presence"
  "penpito/pumps/state"
  "penpito/motor/state"
)

for topic in "${TOPICS[@]}"; do
  mosquitto_pub -h "$BROKER_HOST" -p "$BROKER_PORT" -t "$topic" -r -n
  echo "Limpiado: $topic"
done

echo "OK. Broker limpio. Reinicia la app Expo para que arranque sin estado retenido."
