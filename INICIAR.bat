@echo off
REM ============================================================
REM  Cotizador de Mantenciones Curifor - servidor local
REM  Doble clic para levantar la plataforma en el navegador.
REM ============================================================
cd /d "%~dp0"
echo.
echo   Iniciando Cotizador de Mantenciones Curifor...
echo   Abriendo http://localhost:8010
echo.
echo   Deja esta ventana abierta mientras uses la plataforma.
echo   Para cerrar, presiona Ctrl+C o cierra la ventana.
echo.
start "" "http://localhost:8010"
python -m http.server 8010
