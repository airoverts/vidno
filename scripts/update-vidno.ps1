param(
    [string]$ServerAddress = "192.168.0.101",
    [string]$ServerUser = "boss"
)

ssh "$ServerUser@$ServerAddress" "~/projects/vidno/vidno/scripts/update-vidno.sh"
exit $LASTEXITCODE
