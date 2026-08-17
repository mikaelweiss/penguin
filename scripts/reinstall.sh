#!/bin/bash

npm uninstall -g wa

rm -rf ~/.wa

npm install

npm run build

npm install -g .
