#!/usr/bin/env bash
#
# install.sh — Instalador / actualizador de Gemini CLI (fork).
#
# Detecta la última release del fork, hace backup de ~/.gemini, elimina
# versiones previas (npm global, symlink, otras carpetas en ~/opt) y
# reinstala. Si el fork ya está instalado, solo actualiza si hay versión nueva.
#
# Instalación rápida (repo público: sin token):
#   curl -fsSL https://raw.githubusercontent.com/Blackmanx/gemini-cli/main/install.sh | bash
#
# Ajusta Blackmanx/gemini-cli a donde esté alojado el fork, o exporta GEMINI_REPO.
#
# Uso:
#   bash install.sh                 # instala / actualiza a la última release
#   bash install.sh --version vX    # instala una release concreta
#   bash install.sh --npm           # fuerza instalación vía npm global
#   bash install.sh --symlink       # fuerza instalación vía unzip + symlink
#   bash install.sh --force         # reinstala aunque ya estés al día
#   bash install.sh --keep-config   # NO resetea ~/.gemini (solo backup)
#   bash install.sh --no-backup     # no hace backup de ~/.gemini
#   bash install.sh --uninstall     # desinstala el fork
#   bash install.sh --dry-run       # muestra lo que haría, sin ejecutar
#
# Nota: al usar `curl | bash` puedes pasar flags con `bash -s -- <flags>`.
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuración
# ---------------------------------------------------------------------------
REPO="${GEMINI_REPO:-Blackmanx/gemini-cli}"
API_URL="https://api.github.com/repos/${REPO}"

INSTALL_ROOT="${GEMINI_INSTALL_ROOT:-${HOME}/opt}"          # donde viven las carpetas gemini-cli-<version>
BIN_DIR="${GEMINI_BIN_DIR:-${HOME}/.local/bin}"             # donde va el symlink 'gemini'
STATE_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/gemini-cli"
STATE_FILE="${STATE_DIR}/install-info"
CONFIG_DIR="${GEMINI_CONFIG_DIR:-${HOME}/.gemini}"          # dir de configuración del CLI
BACKUP_DIR="${GEMINI_BACKUP_DIR:-${BACKUP_DIR:-${HOME}/.gemini-backups}}"

# Nombres de paquetes npm que pueden estar instalados (oficial + fork).
NPM_PACKAGES=( "@google/gemini-cli" "@google-gemini/gemini-cli" )

# Regex de los assets en la release (buscan el substring en la URL de descarga).
ASSET_BUNDLE_RE='gemini-cli-bundle\.zip'
ASSET_TGZ_RE='gemini-cli-[^/]*\.tgz'

# ---------------------------------------------------------------------------
# Utilidades de log / color
# ---------------------------------------------------------------------------
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  C_RESET="$(tput sgr0)"; C_BOLD="$(tput bold)"
  C_RED="$(tput setaf 1)"; C_GREEN="$(tput setaf 2)"; C_YELLOW="$(tput setaf 3)"
  C_BLUE="$(tput setaf 4)"; C_CYAN="$(tput setaf 6)"
else
  C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_CYAN=""
fi

info()    { printf '%s\n' "${C_BLUE}==>${C_RESET} $*"; }
success() { printf '%s\n' "${C_GREEN}✔${C_RESET} $*"; }
warn()    { printf '%s\n' "${C_YELLOW}⚠${C_RESET} $*" >&2; }
error()   { printf '%s\n' "${C_RED}✘${C_RESET} $*" >&2; }
die()     { error "$@"; exit 1; }
step()    { printf '%s\n' "${C_CYAN}·${C_RESET} $*"; }

# Ejecuta un comando respetando --dry-run.
run() {
  if [[ "${DRY_RUN}" == true ]]; then
    printf '  %s(dry-run)%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*"
    return 0
  fi
  "$@"
}

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
FORCE=false
DRY_RUN=false
NO_BACKUP=false
KEEP_CONFIG=false
DO_UNINSTALL=false
METHOD="auto"          # auto | npm | symlink
TARGET_VERSION=""      # vacío = última release

usage() {
  # Here-doc estático (no lee $0): así funciona también con `curl | bash`,
  # donde $0 es "bash" y no hay fichero del que leer.
  cat <<'EOF'
install.sh — Instalador / actualizador de Gemini CLI (fork).

Instalación rápida (repo público: sin token):
  curl -fsSL https://raw.githubusercontent.com/Blackmanx/gemini-cli/main/install.sh | bash

Uso:
  bash install.sh                 # instala / actualiza a la última release
  bash install.sh --version vX    # instala una release concreta
  bash install.sh --npm           # fuerza instalación vía npm global
  bash install.sh --symlink       # fuerza instalación vía unzip + symlink
  bash install.sh --force         # reinstala aunque ya estés al día
  bash install.sh --keep-config   # NO resetea ~/.gemini (solo backup)
  bash install.sh --no-backup     # no hace backup de ~/.gemini
  bash install.sh --uninstall     # desinstala el fork
  bash install.sh --dry-run       # muestra lo que haría, sin ejecutar

Con `curl | bash` puedes pasar flags con:  ... | bash -s -- --npm --force
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)     usage ;;
    --version)     TARGET_VERSION="${2:-}"; shift 2 ;;
    --version=*)   TARGET_VERSION="${1#*=}"; shift ;;
    --force)       FORCE=true; shift ;;
    --dry-run)     DRY_RUN=true; shift ;;
    --no-backup)   NO_BACKUP=true; shift ;;
    --keep-config) KEEP_CONFIG=true; shift ;;
    --uninstall)   DO_UNINSTALL=true; shift ;;
    --npm)         METHOD="npm"; shift ;;
    --symlink)     METHOD="symlink"; shift ;;
    --method)      METHOD="${2:-}"; shift 2 ;;
    *)             die "Flag desconocido: $1 (usa --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Dependencias
# ---------------------------------------------------------------------------
check_deps() {
  local need=(curl tar)
  if [[ "${METHOD}" == "auto" || "${METHOD}" == "symlink" ]]; then
    need+=(unzip)
  fi
  local missing=()
  for c in "${need[@]}"; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    die "Faltan dependencias: ${missing[*]}  (instálalas y vuelve a ejecutar)"
  fi
}

have_npm() { command -v npm >/dev/null 2>&1; }

# ¿El destino global de npm es escribible por el usuario actual?
# Comprueba `npm root -g` (p. ej. /usr/lib/node_modules), NO el prefijo:
# el prefijo (/usr) puede ser escribible mientras que el destino real no lo
# es, y entonces npm install -g muere con EACCES. Si el destino aún no
# existe, se comprueba el ancestro existente más cercano.
npm_global_writable() {
  have_npm || return 1
  local dir
  dir="$(npm root -g 2>/dev/null)" || return 1
  [[ -n "$dir" ]] || return 1
  while [[ ! -e "$dir" && "$dir" != "/" && "$dir" != "." ]]; do
    dir="$(dirname "$dir")"
  done
  [[ -d "$dir" && -w "$dir" ]]
}

# ---------------------------------------------------------------------------
# HTTP — GET con autenticación de GitHub.
# El repo es privado, así que necesitamos un token. Orden de preferencia:
#   1) GITHUB_TOKEN / GH_TOKEN (env)
#   2) token de `gh auth token` (si gh está instalado y logueado)
#   3) sin auth (fallará con 404 si el repo es privado)
# ---------------------------------------------------------------------------
_auth_token=""
get_auth_token() {
  [[ -n "${_auth_token}" ]] && return 0
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    _auth_token="${GITHUB_TOKEN}"
  elif [[ -n "${GH_TOKEN:-}" ]]; then
    _auth_token="${GH_TOKEN}"
  elif command -v gh >/dev/null 2>&1; then
    _auth_token="$(gh auth token 2>/dev/null || true)"
  fi
  [[ -n "${_auth_token}" ]]
}

gh_curl() {
  local url="$1"
  local -a args=(-fsSL --retry 3 --retry-delay 1 -H "Accept: application/vnd.github+json")
  if get_auth_token; then
    args+=(-H "Authorization: Bearer ${_auth_token}")
  else
    warn "Sin token de GitHub. Si el repo es privado, la petición fallará."
    warn "Exporta GITHUB_TOKEN o instala/authentica 'gh'."
  fi
  curl "${args[@]}" "$url"
}

# ---------------------------------------------------------------------------
# Helpers de JSON vía Node (Node >=20 es requisito del propio Gemini CLI).
# Evitan parsers frágiles con grep/sed sobre JSON anidado.
# ---------------------------------------------------------------------------
json_tag() {   # $1=json de release → imprime tag_name
  printf '%s' "$1" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { process.stdout.write(JSON.parse(s).tag_name ?? ""); } catch { }
    });'
}

json_assets() {  # $1=json de release → imprime "<id> <name>" por asset
  printf '%s' "$1" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try {
        const a = JSON.parse(s).assets ?? [];
        for (const x of a) process.stdout.write(`${x.id} ${x.name}\n`);
      } catch { }
    });'
}

# ---------------------------------------------------------------------------
# Resolución de versiones
# ---------------------------------------------------------------------------
normalize_tag() {  # quita la 'v' inicial si existe
  local v="$1"
  printf '%s' "${v#v}"
}

# El tag de git es "v0.66.0-dbc7786a6" y el CLI reporta "0.66.0-dbc7786a6":
# el prefijo 'v' es lo único que difiere. canonical() unifica para comparar;
# tag_to_version() convierte el tag al formato de versión (para nombrar
# directorios y mostrar en pantalla).
canonical() {
  printf '%s' "$1"
}

tag_to_version() {
  printf '%s' "$1"
}

get_latest_release() {
  local json
  if ! json="$(gh_curl "${API_URL}/releases/latest")"; then
    die "No se pudo consultar la última release de ${REPO}.
       ¿Hay conexión a Internet? ¿GitHub accesible?
       Si el repo no es público, exporta GITHUB_TOKEN o autentica 'gh'
       (gh auth login) y reintenta."
  fi
  local tag
  tag="$(json_tag "$json")"
  [[ -n "$tag" ]] || die "No se pudo leer el tag de la última release."
  printf '%s' "$tag"
}

get_release_assets() {   # imprime: "<asset_id> <asset_name>" por asset
  local tag="$1"
  local enc_tag json
  enc_tag="$(printf '%s' "$tag" | sed 's|/|%2F|g')"
  json="$(gh_curl "${API_URL}/releases/tags/${enc_tag}")" \
    || die "No se pudo leer la release ${tag}."
  json_assets "$json"
}

pick_asset_id() {   # $1=pares "id nombre", $2=regex del nombre buscado
  local pairs="$1" pattern="$2"
  printf '%s\n' "$pairs" | grep -E "[[:space:]]${pattern}$" | head -1 | awk '{print $1}'
}

download_asset() {  # $1=asset_id, $2=destino. Usa el endpoint de API autenticado.
  local id="$1" dest="$2"
  local url="${API_URL}/releases/assets/${id}"
  local -a args=(-fsSL --retry 3 --retry-delay 1
                 -H "Accept: application/octet-stream"
                 -H "X-GitHub-Api-Version: 2022-11-28")
  get_auth_token && args+=(-H "Authorization: Bearer ${_auth_token}")
  curl "${args[@]}" -o "${dest}" "$url"
}

# ---------------------------------------------------------------------------
# Detección de instalaciones existentes
# ---------------------------------------------------------------------------
installed_version_from_bin() {
  # Sondea el binario instalado directamente (no depende de que BIN_DIR
  # esté en el PATH de esta sesión) y, como fallback, vía PATH.
  local probe
  for probe in "${BIN_DIR}/gemini"; do
    if [[ -e "$probe" ]]; then
      local v
      v="$("$probe" --version 2>/dev/null | head -1 | tr -d '[:space:]' | sed 's/^v//' || true)"
      [[ -n "$v" ]] && { printf '%s' "$v"; return 0; }
    fi
  done
  if command -v gemini >/dev/null 2>&1; then
    gemini --version 2>/dev/null | head -1 | tr -d '[:space:]' | sed 's/^v//'
  fi
}

detect_fork_dirs() {
  # Carpetas gemini-cli-* dentro de INSTALL_ROOT.
  [[ -d "${INSTALL_ROOT}" ]] || return 0
  find "${INSTALL_ROOT}" -maxdepth 1 -type d -name 'gemini-cli-*' 2>/dev/null | sort
}

detect_windows_gemini() {
  # En WSL, 'gemini' puede resolvar a un binario de Windows (/mnt/c/...).
  # Devuelve la ruta si existe.
  if command -v gemini >/dev/null 2>&1; then
    local p
    p="$(command -v gemini)"
    case "$p" in
      /mnt/*|/cygdrive/*) printf '%s' "$p" ;;
    esac
  fi
}

# ---------------------------------------------------------------------------
# Backup / reset de ~/.gemini
# ---------------------------------------------------------------------------
backup_config() {
  [[ "${NO_BACKUP}" == true ]] && return 0
  [[ -d "${CONFIG_DIR}" ]] || { step "No existe ${CONFIG_DIR}, nada que respaldar."; return 0; }

  run mkdir -p "${BACKUP_DIR}"
  local stamp ts archive
  stamp="$(basename "${INSTALLED_VERSION:-none}")"
  ts="$(date +%Y%m%d-%H%M%S)"
  archive="${BACKUP_DIR}/gemini-config-${stamp}-${ts}.tar.gz"

  info "Respaldando ${CONFIG_DIR} → ${archive}"
  run tar -czf "${archive}" -C "$(dirname "${CONFIG_DIR}")" "$(basename "${CONFIG_DIR}")"
  success "Backup creado: ${archive}"
  BACKUP_ARCHIVE="${archive}"
}

reset_config() {
  [[ "${KEEP_CONFIG}" == true ]] && { step "Se conserva ${CONFIG_DIR} (--keep-config)."; return 0; }
  [[ -d "${CONFIG_DIR}" ]] || return 0
  info "Reseteando ${CONFIG_DIR} (backup ya realizado)"
  run rm -rf "${CONFIG_DIR}"
}

# ---------------------------------------------------------------------------
# Limpieza de versiones previas
# ---------------------------------------------------------------------------
remove_npm_installs() {
  if ! have_npm; then
    step "npm no disponible; se omite limpieza de paquetes globales."
    return 0
  fi
  for pkg in "${NPM_PACKAGES[@]}"; do
    if npm ls -g --depth=0 "$pkg" >/dev/null 2>&1; then
      info "Desinstalando paquete npm global: ${pkg}"
      run npm uninstall -g "$pkg" || warn "No se pudo desinstalar ${pkg} (¿permisos?). Prueba con sudo."
    fi
  done
}

remove_symlink() {
  local link="${BIN_DIR}/gemini"
  if [[ -L "$link" ]]; then
    info "Eliminando symlink ${link}"
    run rm -f "$link"
  elif [[ -e "$link" ]]; then
    warn "${link} existe pero no es un symlink; se deja intacto (revísalo a mano)."
  fi
}

remove_fork_dirs() {
  local dirs
  dirs="$(detect_fork_dirs)"
  [[ -z "$dirs" ]] && return 0
  local d
  while IFS= read -r d; do
    [[ -z "$d" ]] && continue
    # No borramos la carpeta que vamos a reutilizar si coincide con la versión destino.
    if [[ -n "${TARGET_DIR:-}" && "$d" == "${TARGET_DIR}" ]]; then
      continue
    fi
    info "Eliminando instalación previa: ${d}"
    run rm -rf "$d"
  done <<< "$dirs"
}

handle_windows_shadow() {
  local win_bin
  win_bin="$(detect_windows_gemini || true)"
  [[ -z "$win_bin" ]] && return 0
  warn "Se detectó un 'gemini' de Windows en WSL: ${win_bin}"
  warn "Se instalará una copia local en ${BIN_DIR}; asegúrate de que"
  warn "${BIN_DIR} aparezca ANTES de las rutas de Windows en tu PATH."
  case ":${PATH}:" in
    *":${BIN_DIR}:"*)
      if [[ "${PATH%%"${BIN_DIR}"*}" == *"/mnt/c"* || "${PATH%%"${BIN_DIR}"*}" == *"/cygdrive"* ]]; then
        warn "Atención: ${BIN_DIR} precede a rutas Windows, bien."
      else
        step "${BIN_DIR} está en tu PATH (normalmente antes de las rutas de Windows en WSL)."
      fi
      ;;
    *)
      warn "${BIN_DIR} NO está en tu PATH. Añade a tu ~/.bashrc o ~/.zshrc:"
      warn "  export PATH=\"${BIN_DIR}:\$PATH\""
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Instalación
# ---------------------------------------------------------------------------
resolve_method() {
  if [[ "${METHOD}" != "auto" ]]; then
    printf '%s' "${METHOD}"
    return 0
  fi
  # Auto: npm solo si además es escribible; si no, symlink (sin permisos).
  if npm_global_writable; then
    printf 'npm'
  else
    printf 'symlink'
  fi
}

install_via_npm() {
  local tgz="$1"
  have_npm || die "Se eligió el método npm pero no hay npm en PATH."
  if ! npm_global_writable; then
    die "El prefijo global de npm no es escribible (probablemente hace falta sudo).
       Puedes:  1) volver a ejecutar con sudo,  o
               2) usar el método symlink (no necesita permisos):  --symlink"
  fi

  # El fork también expone el bin 'gemini'. Si otro paquete npm (el oficial
  # @google/gemini-cli, un nightly u otro fork) ya creó ese bin, npm aborta
  # con EEXIST. Hay que liberarlo ANTES de instalar: desinstalamos los
  # paquetes oficiales conocidos y, si aún queda un bin 'gemini' ajeno en el
  # directorio global, lo eliminamos (vamos a poner el nuestro encima).
  remove_npm_installs
  local gbin
  gbin="$(npm prefix -g 2>/dev/null)/bin/gemini"
  if [[ -e "$gbin" || -L "$gbin" ]]; then
    info "Liberando bin global ocupado: ${gbin}"
    run rm -f "$gbin"
  fi

  info "Instalando vía npm global: ${tgz}"
  run npm install -g "$tgz"
}

install_via_symlink() {
  local zip="$1" version="$2"
  local target_dir="${INSTALL_ROOT}/gemini-cli-${version}"
  # El staging es un nombre distinto al definitivo para poder extraer y
  # verificar sin tocar (ni dejar a medias) la instalación que ya funciona.
  local staging="${target_dir}.staging"
  TARGET_DIR="${target_dir}"

  info "Extrayendo bundle a ${staging}"
  run mkdir -p "${INSTALL_ROOT}"
  run rm -rf "${staging}"
  run unzip -qo "${zip}" -d "${staging}"

  local gemini_js="${staging}/bundle/gemini.js"
  if [[ "${DRY_RUN}" == false && ! -f "${gemini_js}" ]]; then
    # Algunos zips traen un nivel extra; busca el gemini.js real.
    gemini_js="$(find "${staging}" -maxdepth 3 -name 'gemini.js' -path '*/bundle/*' | head -1 || true)"
    [[ -n "${gemini_js}" && -f "${gemini_js}" ]] \
      || die "No se encontró bundle/gemini.js en el zip. Tu instalación no se ha tocado."
  fi

  run chmod +x "${gemini_js}"

  # Verificar el bundle ANTES de sustituir el directorio definitivo. Si no
  # arranca, abortamos aquí y la instalación previa sigue intacta.
  if [[ "${DRY_RUN}" == false ]]; then
    if ! "${gemini_js}" --version >/dev/null 2>&1; then
      run rm -rf "${staging}"
      die "El bundle descargado no responde al ejecutarse. Tu instalación no se ha tocado."
    fi
  fi

  # Sustituir de forma casi atómica: quitar el destino viejo y mover el
  # staging verificado encima; después sí, fijar el symlink.
  run rm -rf "${target_dir}"
  run mv "${staging}" "${target_dir}"

  local final_js="${target_dir}/bundle/gemini.js"
  [[ -f "${final_js}" ]] || final_js="$(find "${target_dir}" -maxdepth 3 -name 'gemini.js' -path '*/bundle/*' | head -1 || true)"

  info "Creando symlink ${BIN_DIR}/gemini → ${final_js}"
  run mkdir -p "${BIN_DIR}"
  run ln -sf "${final_js}" "${BIN_DIR}/gemini"
}

write_state() {
  local version="$1" method="$2" tag="$3"
  run mkdir -p "${STATE_DIR}"
  if [[ "${DRY_RUN}" == false ]]; then
    cat > "${STATE_FILE}" <<EOF
version=${version}
tag=${tag}
method=${method}
installed_at=$(date -Iseconds)
repo=${REPO}
EOF
  else
    step "(dry-run) no se escribe ${STATE_FILE}"
  fi
}

# ---------------------------------------------------------------------------
# Desinstalación
# ---------------------------------------------------------------------------
do_uninstall() {
  info "Desinstalando fork Gemini CLI (${REPO})"
  remove_npm_installs
  remove_symlink
  # Borra todas las carpetas del fork.
  local dirs
  dirs="$(detect_fork_dirs)"
  if [[ -n "$dirs" ]]; then
    local d
    while IFS= read -r d; do
      [[ -z "$d" ]] && continue
      info "Eliminando ${d}"
      run rm -rf "$d"
    done <<< "$dirs"
  fi
  run rm -f "${STATE_FILE}"
  success "Desinstalado. ${CONFIG_DIR} y tus backups en ${BACKUP_DIR} se conservan."
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  check_deps

  if [[ "${DO_UNINSTALL}" == true ]]; then
    do_uninstall
    exit 0
  fi

  # 1) Versión instalada actual.
  INSTALLED_VERSION="$(installed_version_from_bin || true)"
  [[ -z "${INSTALLED_VERSION}" && -f "${STATE_FILE}" ]] \
    && INSTALLED_VERSION="$(grep '^version=' "${STATE_FILE}" | head -1 | cut -d= -f2-)"

  # 2) Versión destino.
  local target_tag
  if [[ -n "${TARGET_VERSION}" ]]; then
    target_tag="v$(normalize_tag "${TARGET_VERSION}")"
    info "Versión objetivo forzada: ${target_tag}"
  else
    info "Consultando última release de ${REPO}…"
    target_tag="$(get_latest_release)"
    info "Última release: ${target_tag}"
  fi
  local target_version
  target_version="$(tag_to_version "$(normalize_tag "${target_tag}")")"

  # 3) ¿Necesita actualizar? (compara en forma canónica el tag con la versión
  #    instalada).
  if [[ "${FORCE}" == false && -n "${INSTALLED_VERSION}" \
        && "$(canonical "$(normalize_tag "${INSTALLED_VERSION}")")" == "$(canonical "${target_version}")" ]]; then
    success "Ya tienes la última versión (${INSTALLED_VERSION}). Usa --force para reinstalar."
    exit 0
  fi

  if [[ -n "${INSTALLED_VERSION}" ]]; then
    info "Actualizando ${INSTALLED_VERSION} → ${target_version}"
  else
    info "Instalando ${target_version} (no se detectó instalación previa)"
  fi

  # 4) Assets de la release (id + nombre).
  local assets
  assets="$(get_release_assets "${target_tag}")"
  [[ -z "${assets}" ]] && die "La release ${target_tag} no tiene assets descargables."

  local chosen_method
  chosen_method="$(resolve_method)"
  local asset_id asset_name
  if [[ "${chosen_method}" == "npm" ]]; then
    asset_id="$(pick_asset_id "${assets}" "${ASSET_TGZ_RE}")"
    asset_name="gemini-cli.tgz"
  else
    asset_id="$(pick_asset_id "${assets}" "${ASSET_BUNDLE_RE}")"
    asset_name="gemini-cli-bundle.zip"
  fi
  [[ -z "${asset_id}" ]] && die "No se encontró el asset adecuado (${chosen_method}) en ${target_tag}."
  step "Método: ${chosen_method}"
  step "Asset:  ${asset_name} (id ${asset_id})"

  # 5) Descarga del asset a un fichero temporal (repo privado: vía API).
  #    Se descarga ANTES de tocar nada: si falla, tu instalación actual
  #    queda intacta.
  local tmp_asset
  tmp_asset="$(mktemp -t "gemini-asset.XXXXXX.${asset_name##*.}")"
  # shellcheck disable=SC2064
  trap "rm -f '${tmp_asset}'" EXIT
  if [[ "${DRY_RUN}" == true ]]; then
    step "(dry-run) descargaría asset id ${asset_id} → ${tmp_asset}"
  else
    info "Descargando ${asset_name}…"
    download_asset "${asset_id}" "${tmp_asset}" \
      || die "No se pudo descargar ${asset_name}. Tu instalación no se ha tocado. ¿Token válido?"
  fi

  # 6) Instalación en su sitio. Para symlink se extrae a un staging y solo
  #    se sustituye el directorio y se fija el symlink cuando el bundle ya
  #    ha demostrado arrancar. La instalación previa sigue viva hasta aquí.
  case "${chosen_method}" in
    npm)     install_via_npm "${tmp_asset}" ;;
    symlink) install_via_symlink "${tmp_asset}" "${target_version}" ;;
    *)       die "Método desconocido: ${chosen_method}" ;;
  esac

  # 7) Verificación final del binario en su ubicación definitiva.
  if [[ "${DRY_RUN}" == false ]]; then
    verify_binary "${target_version}" \
      || die "El binario instalado no responde. Revisa el error; tu versión anterior no se ha eliminado."
  fi

  # 8) SOLO ahora, con la nueva versión instalada y verificada, se limpia lo
  #    viejo. Nunca antes: así un fallo arriba no deja el sistema sin gemini.
  info "Limpiando instalaciones previas…"
  remove_fork_dirs
  if [[ "${chosen_method}" == "npm" ]]; then
    # El método npm ya desinstaló los paquetes oficiales ANTES de instalar
    # (por el conflicto del bin 'gemini'); aquí solo limpiamos un symlink
    # sobrante de una instalación previa por symlink.
    remove_symlink
  else
    # Método symlink: retira paquetes npm oficiales que sombrearían el binario.
    remove_npm_installs
  fi

  # 9) Configuración: backup + reset SOLO en instalación nueva. En una
  #    actualización ~/.gemini se conserva tal cual (tokens, settings, etc.).
  if [[ -z "${INSTALLED_VERSION}" ]]; then
    backup_config
    reset_config
  else
    step "Actualización: se conserva ${CONFIG_DIR} (sin backup ni reset)."
  fi

  # 10) Estado + aviso de shadow de Windows.
  write_state "${target_version}" "${chosen_method}" "${target_tag}"
  handle_windows_shadow

  echo
  success "Instalación completada: ${target_version} (${chosen_method})"
  if [[ -z "${INSTALLED_VERSION}" ]]; then
    if [[ "${KEEP_CONFIG}" == true ]]; then
      info "Se conservó tu configuración actual en ${CONFIG_DIR}."
    elif [[ -n "${BACKUP_ARCHIVE:-}" ]]; then
      info "Backup de configuración: ${BACKUP_ARCHIVE}"
      warn "${CONFIG_DIR} fue reseteado (instalación nueva). Para recuperar:"
      warn "  tar -xzf ${BACKUP_ARCHIVE} -C ${HOME}"
    else
      step "Instalación nueva sin ${CONFIG_DIR} previo; nada que respaldar."
    fi
  else
    info "Configuración intacta en ${CONFIG_DIR}."
  fi
}

# Imprime la versión que responde el binario instalado, o vacío si falla.
# Prueba el symlink y la carpeta de la versión directamente (no depende de
# que BIN_DIR esté en el PATH de esta sesión).
verify_binary() {
  local version="$1" got="" probe
  for probe in "${BIN_DIR}/gemini" "${INSTALL_ROOT}/gemini-cli-${version}/bundle/gemini.js"; do
    if [[ -e "$probe" ]]; then
      got="$("$probe" --version 2>/dev/null | head -1 | tr -d '[:space:]' || true)"
      [[ -n "$got" ]] && break
    fi
  done
  if [[ -z "$got" ]] && command -v gemini >/dev/null 2>&1; then
    got="$(gemini --version 2>/dev/null | head -1 | tr -d '[:space:]' || true)"
  fi
  [[ -n "$got" ]] || return 1
  success "Verificado: gemini ${got}"
}

main "$@"
