/* dikeys.c -- key names for the DirectInput keyboard objects.
 *
 * The game's Controls page shows a keyboard binding as the tszName of the
 * key's object (IDirectInputDevice8::GetObjectInfo, 0x5b8d90), so these are
 * the names Windows' DirectInput gives the keys on a US layout, except that
 * the modifiers and a few keys carry their Mac names (keyboard_mac.m maps
 * Option to DIK_LMENU, Clear to DIK_NUMLOCK; Help, Insert on PC keyboards,
 * to DIK_INSERT).  Keys that type a character are named after it on the
 * keyboard layout in use (kbdmac_layout_name, as Windows names them after
 * the active layout); this table is the fallback.  A key without a name
 * does not exist (dinput_kbd.c enumerates and maps only these). */
#include <stddef.h>

const char *dik_name(unsigned dik){
    static const char *const T[256] = {
        [0x01] = "Esc",
        [0x02] = "1", [0x03] = "2", [0x04] = "3", [0x05] = "4", [0x06] = "5",
        [0x07] = "6", [0x08] = "7", [0x09] = "8", [0x0A] = "9", [0x0B] = "0",
        [0x0C] = "-", [0x0D] = "=", [0x0E] = "Backspace", [0x0F] = "Tab",
        [0x10] = "Q", [0x11] = "W", [0x12] = "E", [0x13] = "R", [0x14] = "T",
        [0x15] = "Y", [0x16] = "U", [0x17] = "I", [0x18] = "O", [0x19] = "P",
        [0x1A] = "[", [0x1B] = "]", [0x1C] = "Enter", [0x1D] = "Control",
        [0x1E] = "A", [0x1F] = "S", [0x20] = "D", [0x21] = "F", [0x22] = "G",
        [0x23] = "H", [0x24] = "J", [0x25] = "K", [0x26] = "L",
        [0x27] = ";", [0x28] = "'", [0x29] = "`", [0x2A] = "Shift", [0x2B] = "\\",
        [0x2C] = "Z", [0x2D] = "X", [0x2E] = "C", [0x2F] = "V", [0x30] = "B",
        [0x31] = "N", [0x32] = "M", [0x33] = ",", [0x34] = ".", [0x35] = "/",
        [0x36] = "Right Shift", [0x37] = "Num *", [0x38] = "Option", [0x39] = "Space",
        [0x3A] = "Caps Lock",
        [0x3B] = "F1", [0x3C] = "F2", [0x3D] = "F3", [0x3E] = "F4", [0x3F] = "F5",
        [0x40] = "F6", [0x41] = "F7", [0x42] = "F8", [0x43] = "F9", [0x44] = "F10",
        [0x45] = "Clear", [0x46] = "Scroll Lock",
        [0x47] = "Num 7", [0x48] = "Num 8", [0x49] = "Num 9", [0x4A] = "Num -",
        [0x4B] = "Num 4", [0x4C] = "Num 5", [0x4D] = "Num 6", [0x4E] = "Num +",
        [0x4F] = "Num 1", [0x50] = "Num 2", [0x51] = "Num 3", [0x52] = "Num 0",
        [0x53] = "Num .", [0x56] = "<", [0x57] = "F11", [0x58] = "F12",
        [0x64] = "F13", [0x65] = "F14", [0x66] = "F15", [0x70] = "Kana", [0x73] = "Ro",
        [0x7B] = "Eisu", [0x7D] = "Yen", [0x8D] = "Num =", [0xB3] = "Num ,",
        [0x9C] = "Num Enter", [0x9D] = "Right Control", [0xB5] = "Num /",
        [0xB7] = "Print Screen", [0xB8] = "Right Option", [0xC5] = "Pause",
        [0xC7] = "Home", [0xC8] = "Up", [0xC9] = "Page Up", [0xCB] = "Left",
        [0xCD] = "Right", [0xCF] = "End", [0xD0] = "Down", [0xD1] = "Page Down",
        [0xD2] = "Insert", [0xD3] = "Delete", [0xDB] = "Command", [0xDC] = "Right Command",
        [0xDD] = "Menu",
    };
    return dik < 256 ? T[dik] : NULL;
}
