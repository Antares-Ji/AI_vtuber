#!/bin/sh
set -eu
cd "$(dirname "$0")"
MC_JAVA_HOME=${MC_JAVA_HOME:-'/Users/ronak/Library/Application Support/minecraft/runtime/java-runtime-epsilon/mac-os-arm64/java-runtime-epsilon/jre.bundle/Contents/Home'}
cd server
exec "$MC_JAVA_HOME/bin/java" -javaagent:../observer/dragon-observer.jar=3093 -Xms512M -Xmx2G -jar server.jar nogui
