#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
BUILD_JAVA='/Users/ronak/Library/Application Support/minecraft/runtime/java-runtime-epsilon/mac-os-arm64/java-runtime-epsilon/jre.bundle/Contents/Home/bin'
"$BUILD_JAVA/javac" --release 17 -cp "observer/javassist.jar:$(cat native-client/classpath.txt)" -d native-client/classes native-client/NativeViewAgent.java native-client/FrameCapture.java native-client/NativeUi.java
"$BUILD_JAVA/jar" cfm native-client/native-view-agent.jar native-client/MANIFEST.MF -C native-client/classes .
