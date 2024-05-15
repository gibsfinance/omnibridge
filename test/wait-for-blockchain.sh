
blockchain_running() {
  nc -z $HOSTNAME 8545
}

while ! blockchain_running; do
  echo "waiting for blockchain"
  sleep 1
done
