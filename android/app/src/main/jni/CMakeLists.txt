# The privileged PTY host. See ofspty.c for why a standalone binary is used instead of the Termux
# library that ships in this APK: that library cannot be loaded outside the app's own process.

cmake_minimum_required(VERSION 3.22.1)

project(ofspty C)

# An executable, not a SHARED library, even though the artifact ships as a jniLib and is named like
# one. A shared object is an ET_DYN with no PT_INTERP and no entry point, and execve() refuses it
# with ENOEXEC — while an executable that is merely *named* lib*.so still gets packaged into the
# native library directory, which is the one place a privileged process can execute it from.
add_executable(ofspty ofspty.c)

set_target_properties(ofspty PROPERTIES
    PREFIX "lib"
    SUFFIX ".so"
)

target_compile_options(ofspty PRIVATE -Wall -Wextra -O2)

# No extra link libraries: forkpty and the pty ioctls live in bionic's libc on Android, so there is
# no libutil to link, and the helper reports through its own stderr rather than through logcat.
