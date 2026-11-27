#!/bin/sh
set -eu
cd "$(dirname "$0")"
MC_JAVA_HOME=${MC_JAVA_HOME:-'/Users/ronak/Library/Application Support/minecraft/runtime/java-runtime-epsilon/mac-os-arm64/java-runtime-epsilon/jre.bundle/Contents/Home'}
if [ ! -f observer/javassist.jar ]; then
  curl -fsSL 'https://repo.maven.apache.org/maven2/org/javassist/javassist/3.30.2-GA/javassist-3.30.2-GA.jar' -o observer/javassist.jar
fi
"$MC_JAVA_HOME/bin/javac" -cp observer/javassist.jar observer/DragonObserver.java
"$MC_JAVA_HOME/bin/jar" cfm observer/dragon-observer.jar observer/MANIFEST.MF -C observer DragonObserver.class -C observer 'DragonObserver$1.class'
