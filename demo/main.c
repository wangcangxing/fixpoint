/* keil-ide 沙箱工程源码（不是用户作业）。
 *
 * 除了原来的呼吸灯，这里固定放一个具名 struct + 一个该类型的全局变量，
 * 作为"成员补全 / 悬停 / F12"的回归夹具：符号索引必须能从本文件解析出
 * struct 成员并把它们挂到 cfg 上。
 */
#include <reg51.h>

struct LedConfig {
    unsigned char mode;
    unsigned int period;
};

struct LedConfig cfg;

void delay(unsigned int t)
{
    while (t--);
}

void apply_config(void)
{
    P1 = cfg.mode;
}

void main(void)
{
    unsigned int t;

    cfg.mode = 0xFE;
    cfg.period = 200;
    apply_config();

    while (1)
    {
        for (t = 0; t < 666; t++)
        {
            P1 = 0xFE;
            delay(t);
            P1 = 0xFF;
            delay(666 - t);
        }
    }
}
