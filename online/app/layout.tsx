import type {Metadata} from 'next';
import './globals.css';
export const metadata:Metadata={title:'庞巴迪影视工作台',description:'与影视团队一起写稿、建立人物资产、生图与生视频。使用自己的模型API连接。'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>;}
