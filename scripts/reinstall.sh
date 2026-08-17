#!/bin/bash

npm uninstall -g penguin

rm -rf ~/.penguin

npm install

npm run build

npm install -g .
