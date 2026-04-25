# Viajes Selva — viajesselva.es

Landing de captación de leads para cruceros con sistema de scoring automático y automatizaciones n8n.

## Estructura del proyecto

```
crucerosviajesselva/
├── index.html           ← Landing principal (pública)
├── panel-ofertas.html   ← Panel interno de ofertas (privado)
├── styles.css           ← Estilos compartidos
├── privacidad.html      ← Política de privacidad (pendiente)
├── aviso-legal.html     ← Aviso legal (pendiente)
└── README.md
```

## Sistema de scoring de leads

Cada lead se puntúa automáticamente (invisible al usuario):

| Campo | Opciones de alto score |
|---|---|
| Destino | Caribe/Vuelta al mundo (+10), Alaska/Sudamérica (+9) |
| Viajeros | Familia (+10), Pareja (+9) |
| Fechas | Menos de 3 meses (+10) |
| Presupuesto | +3.000€ o sin límite (+10) |
| Naviera | Silversea/Cunard/Regent (+10) |
| Teléfono | Deja número (+5 bonus) |

### Clasificación automática
- 🔥 **Caliente** (35-50 pts): Telegram TÚ + Email agencia inmediato
- 🌡️ **Tibio** (20-34 pts): Solo Telegram TÚ
- 🧊 **Frío** (<20 pts): Google Sheets silencioso

## Configuración requerida

Sustituye estos 5 valores en los archivos:

1. `TU_VPS` → URL de tu servidor n8n (ej: `https://n8n.tudominio.com`)
2. `TU_TOKEN` → Token del bot de Telegram
3. `TU_CHAT_ID` → Tu Chat ID de Telegram
4. `info@viajesselva.es` → Email real de la agencia
5. `ID_DE_TU_GOOGLE_SHEET` → ID de la hoja de Google Sheets

## Despliegue con GitHub Pages

```bash
git init
git add .
git commit -m "feat: landing inicial viajesselva.es"
git branch -M main
git remote add origin https://github.com/guiacrucerista-del/viajesselva.git
git push -u origin main
```

Luego en GitHub → Settings → Pages → Source: main / root.

Para conectar el dominio viajesselva.es:
1. GitHub Pages → Custom domain → escribe `viajesselva.es`
2. En tu proveedor DNS añade:
   - Registro A: `185.199.108.153`
   - Registro A: `185.199.109.153`
   - Registro A: `185.199.110.153`
   - Registro A: `185.199.111.153`
   - Registro CNAME: `www` → `guiacrucerista-del.github.io`

## Workflows n8n asociados

| Workflow | Webhook URL | Función |
|---|---|---|
| Procesador de leads | `/webhook/lead-selva` | Scoring + clasificación + Google Sheets |
| Envío de ofertas | `/webhook/oferta-naviera` | Filtrar leads por naviera y enviar emails |
| Reporte semanal | Cron lunes 9:00 | Resumen GSC + redes |
| Alerta viral | Webhook Windsor 6h | Detecta posts virales |
| Generador UTM | Manual | URLs diferenciadas por grupo Facebook |
| Ciclo contenido | Cron domingo 20:00 | Plan reposts semanal |
