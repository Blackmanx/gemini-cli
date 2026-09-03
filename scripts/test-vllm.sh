#!/usr/bin/env bash
#
# Helper script to test Gemini CLI with remote or local vLLM / OpenAI-compatible servers.
# Supports Ollama, LM Studio, native vLLM, and a built-in Mock vLLM server.
#
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

BOLD="\033[1m"
GREEN="\033[0;32m"
BLUE="\033[0;34m"
YELLOW="\033[0;33m"
CYAN="\033[0;36m"
RED="\033[0;31m"
RESET="\033[0m"

echo -e "${BOLD}${CYAN}======================================================${RESET}"
echo -e "${BOLD}${CYAN}   Gemini CLI - vLLM & Local Models Test Runner       ${RESET}"
echo -e "${BOLD}${CYAN}======================================================${RESET}"

# Parse command line flags
MODE="chat"
TARGET_PROVIDER=""
CUSTOM_MODEL=""
CUSTOM_URL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify)
      MODE="verify"
      shift
      ;;
    --chat)
      MODE="chat"
      shift
      ;;
    --ollama)
      TARGET_PROVIDER="ollama"
      shift
      ;;
    --lmstudio)
      TARGET_PROVIDER="lmstudio"
      shift
      ;;
    --mock)
      TARGET_PROVIDER="mock"
      shift
      ;;
    --vllm)
      TARGET_PROVIDER="vllm"
      shift
      ;;
    --model)
      CUSTOM_MODEL="$2"
      shift 2
      ;;
    --url)
      CUSTOM_URL="$2"
      shift 2
      ;;
    --help|-h)
      echo "Uso: ./scripts/test-vllm.sh [opciones]"
      echo ""
      echo "Opciones:"
      echo "  --verify       Ejecuta una prueba no interactiva para verificar la conexión"
      echo "  --chat         Inicia la interfaz completa de Gemini CLI (por defecto)"
      echo "  --ollama       Usa Ollama local (http://localhost:11434)"
      echo "  --lmstudio     Usa LM Studio local (http://localhost:1234)"
      echo "  --vllm         Usa vLLM servidor (http://localhost:8000)"
      echo "  --mock         Inicia y usa el servidor Mock vLLM integrado"
      echo "  --model <name> Especifica el modelo a utilizar"
      echo "  --url <url>    Especifica una URL base personalizada"
      exit 0
      ;;
    *)
      echo -e "${RED}Opción desconocida: $1${RESET}"
      exit 1
      ;;
  esac
done

# Ensure packages are built
if [ ! -f "packages/cli/dist/src/gemini.js" ] || [ ! -f "packages/core/dist/src/index.js" ]; then
  echo -e "${YELLOW}Compilando paquetes necesarios...${RESET}"
  npm run build -w @google/gemini-cli-core -w @google/gemini-cli
fi

SELECTED_URL=""
SELECTED_MODEL=""
MOCK_PID=""

cleanup() {
  if [ -n "$MOCK_PID" ] && kill -0 "$MOCK_PID" 2>/dev/null; then
    echo -e "\n${YELLOW}Deteniendo servidor mock...${RESET}"
    kill "$MOCK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Detection function
detect_services() {
  OLLAMA_RUNNING=false
  LMSTUDIO_RUNNING=false
  VLLM_RUNNING=false

  if curl -s -m 1 http://localhost:11434/v1/models >/dev/null 2>&1; then
    OLLAMA_RUNNING=true
  fi

  if curl -s -m 1 http://localhost:1234/v1/models >/dev/null 2>&1; then
    LMSTUDIO_RUNNING=true
  fi

  if curl -s -m 1 http://localhost:8000/v1/models >/dev/null 2>&1; then
    VLLM_RUNNING=true
  fi
}

detect_services

# Resolve Provider
if [ -n "$CUSTOM_URL" ]; then
  SELECTED_URL="$CUSTOM_URL"
  SELECTED_MODEL="${CUSTOM_MODEL:-default}"
elif [ "$TARGET_PROVIDER" == "mock" ]; then
  echo -e "${BLUE}Iniciando servidor mock vLLM en puerto 8000...${RESET}"
  node scripts/mock-vllm-server.mjs &
  MOCK_PID=$!
  sleep 1
  SELECTED_URL="http://127.0.0.1:8000"
  SELECTED_MODEL="${CUSTOM_MODEL:-Qwen/Qwen2.5-Coder-32B-Instruct}"
elif [ "$TARGET_PROVIDER" == "ollama" ]; then
  SELECTED_URL="http://127.0.0.1:11434"
elif [ "$TARGET_PROVIDER" == "lmstudio" ]; then
  SELECTED_URL="http://127.0.0.1:1234"
elif [ "$TARGET_PROVIDER" == "vllm" ]; then
  SELECTED_URL="http://127.0.0.1:8000"
else
  # Auto-detection or menu
  echo -e "${BOLD}Detectando servidores locales disponibles:${RESET}"
  if [ "$OLLAMA_RUNNING" = true ]; then
    echo -e "  [1] ${GREEN}Ollama${RESET} (activo en http://localhost:11434)"
  else
    echo -e "  [1] Ollama (no activo)"
  fi

  if [ "$LMSTUDIO_RUNNING" = true ]; then
    echo -e "  [2] ${GREEN}LM Studio${RESET} (activo en http://localhost:1234)"
  else
    echo -e "  [2] LM Studio (servidor en puerto 1234 no detectado)"
  fi

  if [ "$VLLM_RUNNING" = true ]; then
    echo -e "  [3] ${GREEN}vLLM nativo${RESET} (activo en http://localhost:8000)"
  else
    echo -e "  [3] vLLM nativo (no detectado en http://localhost:8000)"
  fi

  echo -e "  [4] ${CYAN}Mock vLLM Server integrado${RESET} (ligero, simula Qwen 2.5 y Llama 3 con streaming)"

  # Auto-select if Ollama is running
  if [ "$OLLAMA_RUNNING" = true ]; then
    DEFAULT_CHOICE="1"
  elif [ "$LMSTUDIO_RUNNING" = true ]; then
    DEFAULT_CHOICE="2"
  elif [ "$VLLM_RUNNING" = true ]; then
    DEFAULT_CHOICE="3"
  else
    DEFAULT_CHOICE="4"
  fi

  if [ ! -t 0 ]; then
    CHOICE="$DEFAULT_CHOICE"
  else
    read -p "Selecciona una opción [1-4] (por defecto: $DEFAULT_CHOICE): " USER_CHOICE
    CHOICE="${USER_CHOICE:-$DEFAULT_CHOICE}"
  fi

  case "$CHOICE" in
    1)
      SELECTED_URL="http://127.0.0.1:11434"
      ;;
    2)
      SELECTED_URL="http://127.0.0.1:1234"
      # If LM studio has no models loaded, check if lms can load one
      MODELS_JSON=$(curl -s http://127.0.0.1:1234/v1/models 2>/dev/null || echo '{"data":[]}')
      MODEL_COUNT=$(echo "$MODELS_JSON" | grep -o '"id"' | wc -l || true)
      if [ "$MODEL_COUNT" -eq 0 ] && command -v lms >/dev/null 2>&1; then
        echo -e "${YELLOW}LM Studio no tiene ningún modelo cargado actualmente.${RESET}"
        echo -e "Modelos disponibles en disco:"
        lms ls || true
        echo -e "${CYAN}Cargando codegemma-1.1-7b-it...${RESET}"
        lms load codegemma-1.1-7b-it -y || true
      fi
      ;;
    3)
      SELECTED_URL="http://127.0.0.1:8000"
      ;;
    4)
      echo -e "${BLUE}Iniciando servidor mock vLLM en puerto 8000...${RESET}"
      node scripts/mock-vllm-server.mjs &
      MOCK_PID=$!
      sleep 1
      SELECTED_URL="http://127.0.0.1:8000"
      ;;
    *)
      echo -e "${RED}Opción inválida.${RESET}"
      exit 1
      ;;
  esac
fi

# Query available models from endpoint
echo -e "\n${BLUE}Consultando modelos en ${SELECTED_URL}/v1/models...${RESET}"
MODELS_LIST=$(curl -s "${SELECTED_URL}/v1/models" 2>/dev/null || true)

AVAILABLE_MODELS=($(echo "$MODELS_LIST" | grep -o '"id":"[^"]*"' | cut -d'"' -f4 || true))

if [ ${#AVAILABLE_MODELS[@]} -gt 0 ]; then
  echo -e "${GREEN}Modelos encontrados (${#AVAILABLE_MODELS[@]}):${RESET}"
  for i in "${!AVAILABLE_MODELS[@]}"; do
    echo -e "  [$i] ${AVAILABLE_MODELS[$i]}"
  done

  if [ -n "$CUSTOM_MODEL" ]; then
    SELECTED_MODEL="$CUSTOM_MODEL"
  elif [ "$MODE" == "verify" ] || [ ! -t 0 ]; then
    SELECTED_MODEL="${AVAILABLE_MODELS[0]}"
  else
    read -p "Elige el índice del modelo a usar [0-$((${#AVAILABLE_MODELS[@]}-1))] (por defecto 0): " M_IDX
    M_IDX="${M_IDX:-0}"
    SELECTED_MODEL="${AVAILABLE_MODELS[$M_IDX]:-$SELECTED_MODEL}"
  fi
else
  if [ -n "$CUSTOM_MODEL" ]; then
    SELECTED_MODEL="$CUSTOM_MODEL"
  else
    SELECTED_MODEL="default"
  fi
  echo -e "${YELLOW}No se listaron modelos. Usando '${SELECTED_MODEL}'.${RESET}"
fi

echo -e "\n${BOLD}${GREEN}Configuración establecida:${RESET}"
echo -e "  ${BOLD}VLLM_BASE_URL:${RESET} ${SELECTED_URL}"
echo -e "  ${BOLD}VLLM_MODEL:${RESET}    ${SELECTED_MODEL}"
echo ""

export VLLM_BASE_URL="$SELECTED_URL"
export VLLM_MODEL="$SELECTED_MODEL"

if [ "$MODE" == "verify" ]; then
  echo -e "${CYAN}Ejecutando prueba rápida de verificación...${RESET}"
  node -e "
  import('./packages/core/dist/src/index.js').then(async ({ VllmContentGenerator }) => {
    const gen = new VllmContentGenerator('$SELECTED_URL');
    process.stdout.write('Probando respuesta en streaming: \"');
    const stream = await gen.generateContentStream({
      model: '$SELECTED_MODEL',
      contents: [{ role: 'user', parts: [{ text: 'Di hola y confirma que el modelo está activo en una frase' }] }]
    }, 'test-user-id', 'user');
    for await (const chunk of stream) {
      const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) process.stdout.write(text);
    }
    console.log('\"\n\n\x1b[32m✔ Verificación completada con éxito contra $SELECTED_URL ($SELECTED_MODEL)!\x1b[0m');
  }).catch((err) => {
    console.error('\x1b[31mError durante la verificación:\x1b[0m', err.message);
    process.exit(1);
  });
  "
else
  echo -e "${CYAN}Iniciando Gemini CLI conectado a vLLM/modelo local...${RESET}"
  echo -e "${YELLOW}(Pulsa Ctrl+C o escribe /exit para salir)${RESET}\n"
  node packages/cli --model "$SELECTED_MODEL"
fi
