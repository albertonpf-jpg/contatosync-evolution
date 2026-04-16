@echo off
echo ===============================================
echo   INICIANDO EVOLUTION API - ContatoSync
echo ===============================================
echo.

echo [1/3] Parando containers existentes...
docker-compose -f docker-compose-evolution.yml down

echo.
echo [2/3] Iniciando Evolution API...
docker-compose -f docker-compose-evolution.yml up -d

echo.
echo [3/3] Verificando status...
timeout /t 5 /nobreak >nul

docker ps | findstr evolution-api
if %errorlevel% equ 0 (
    echo.
    echo ✅ SUCCESS: Evolution API rodando!
    echo 🌐 URL: http://localhost:8080
    echo 🔑 API Key: B6D711FCDE4D4FD5936544120E713976
    echo 📖 Docs: http://localhost:8080/docs
) else (
    echo.
    echo ❌ ERRO: Evolution API não iniciou
    echo Verifique: docker-compose logs evolution-api
)

echo.
echo ===============================================
pause