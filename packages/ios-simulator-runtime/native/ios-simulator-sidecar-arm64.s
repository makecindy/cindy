.text
.p2align 2
.globl _cindy_simulator_kit_unmasked_surface
_cindy_simulator_kit_unmasked_surface:
    stp x20, x30, [sp, #-16]!
    mov x20, x0
    bl _$s12SimulatorKit15SimDeviceScreenC15unmaskedSurfaceSo9IOSurfaceCSgvg
    ldp x20, x30, [sp], #16
    ret
