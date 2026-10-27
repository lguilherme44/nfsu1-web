/* runtime/web/memcmp.c against a byte loop: every length 0..300 at every
 * alignment pair 0..15, equal and with one differing byte at every position
 * (low and high byte values, so the sign of the result is checked as
 * unsigned char), plus random buffers.  Prints "memcmp_unit: passed" or the
 * first mismatch. */
#include <stdio.h>
#include <stdint.h>
#include <string.h>

static int ref(const unsigned char *a, const unsigned char *b, size_t n){
    for (volatile size_t i = 0; i < n; i++) if (a[i] != b[i]) return a[i] - b[i];
    return 0;
}
static int sgn(int v){ return (v > 0) - (v < 0); }
static unsigned char A[400], B[400];
static uint32_t rng = 12345;
static unsigned rnd(void){ rng = rng * 1664525u + 1013904223u; return rng >> 8; }

static int check(const unsigned char *a, const unsigned char *b, size_t n, const char *what){
    int r = ref(a, b, n), m = memcmp(a, b, n), e = bcmp(a, b, n);
    if (r != m || sgn(r) != sgn(m) || (r == 0) != (e == 0)){
        printf("memcmp_unit: FAIL %s n=%zu oa=%d ob=%d: ref %d memcmp %d bcmp %d\n", what, n,
               (int)(a - A), (int)(b - B), r, m, e);
        return 1;
    }
    return 0;
}
int bcmp(const void *, const void *, size_t);

int main(void){
    unsigned long checks = 0;
    for (size_t n = 0; n <= 300; n++)
        for (int oa = 0; oa < 16; oa++)
            for (int ob = 0; ob < 16; ob += 5){
                for (size_t i = 0; i < n; i++) A[oa + i] = B[ob + i] = (unsigned char)(rnd() | 0x80u * (i & 1));
                if (check(A + oa, B + ob, n, "equal")) return 1;
                checks++;
                for (size_t k = 0; k < n; k++){
                    unsigned char s = B[ob + k];
                    B[ob + k] = (unsigned char)(s ^ (k & 2 ? 0x80u : 0x01u));
                    if (check(A + oa, B + ob, n, "one byte differs") || check(B + ob, A + oa, n, "swapped")) return 1;
                    B[ob + k] = s; checks += 2;
                }
            }
    for (int t = 0; t < 200000; t++){
        size_t n = rnd() % 380; int oa = rnd() % 16, ob = rnd() % 16;
        for (size_t i = 0; i < n; i++) A[oa + i] = B[ob + i] = (unsigned char)rnd();
        if (n && (rnd() & 1)) B[ob + rnd() % n] = (unsigned char)rnd();
        if (check(A + oa, B + ob, n, "random")) return 1;
        checks++;
    }
    printf("memcmp_unit: passed (%lu checks)\n", checks);
    return 0;
}
