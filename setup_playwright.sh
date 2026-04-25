#!/bin/bash
# setup_playwright.sh
# GuiaCrucerista — Instalación de Playwright en VPS (agente.metricastudio.eu)
# Ejecutar con: bash setup_playwright.sh

set -e
echo "=== GuiaCrucerista — Setup Playwright ==="

SCRIPTS_DIR="/opt/guiacrucerista/scripts"
mkdir -p "$SCRIPTS_DIR"

# Instalar Node.js si no existe
if ! command -v node &> /dev/null; then
  echo "[1/5] Instalando Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "[1/5] Node.js ya instalado: $(node -v)"
fi

# Instalar Playwright
echo "[2/5] Instalando Playwright..."
cd "$SCRIPTS_DIR"

cat > package.json << 'EOF'
{
  "name": "guiacrucerista-playwright",
  "version": "1.0.0",
  "description": "Automatización Facebook para GuiaCrucerista",
  "scripts": {
    "post-grupos": "node playwright_facebook_grupos.js"
  },
  "dependencies": {
    "playwright": "^1.44.0"
  }
}
EOF

npm install

# Instalar navegadores de Playwright
echo "[3/5] Instalando Chromium..."
npx playwright install chromium
npx playwright install-deps chromium

# Copiar script
echo "[4/5] Copiando scripts..."
# El script se copia manualmente desde el repo o vía git pull

# Crear archivo de variables de entorno
if [ ! -f "$SCRIPTS_DIR/.env" ]; then
  echo "[5/5] Creando archivo .env de configuración..."
  cat > "$SCRIPTS_DIR/.env" << 'ENVEOF'
FB_EMAIL=tu_email@gmail.com
FB_PASSWORD=tu_contraseña_facebook
HEADLESS=true
ENVEOF
  echo "⚠️  IMPORTANTE: Edita $SCRIPTS_DIR/.env con tus credenciales reales"
else
  echo "[5/5] Archivo .env ya existe, no se sobreescribe"
fi

chmod 600 "$SCRIPTS_DIR/.env"

echo ""
echo "✅ Setup completado en $SCRIPTS_DIR"
echo ""
echo "Próximos pasos:"
echo "  1. Editar: nano $SCRIPTS_DIR/.env"
echo "  2. Copiar script: cp playwright_facebook_grupos.js $SCRIPTS_DIR/"
echo "  3. Probar login: cd $SCRIPTS_DIR && source .env && node playwright_facebook_grupos.js --text 'Test' --groups '811550587597467'"
echo "  4. Verificar .fb_session.json generado (cookie de sesión persistente)"
