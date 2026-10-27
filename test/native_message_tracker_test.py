# Install the committed fictional registry before importing production adapters.
import pathlib as _test_pathlib
import sys as _test_sys
_test_sys.path.insert(0, str(_test_pathlib.Path(__file__).resolve().parent))
from native_test_bootstrap import configure_test_environment
configure_test_environment()

import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
from native_message_tracker import NativeMessageTracker

def text(i,value):return {'id':str(i),'text':value,'klass':'mmui::ChatTextItemView'}
def voice(i,value):return {'id':str(i),'text':'语音3"秒'+value,'klass':'mmui::ChatVoiceItemView'}

class NativeMessageTrackerTests(unittest.TestCase):
    def setUp(self):self.tracker=NativeMessageTracker()
    def observe(self,rows,count=0,generation='same',name='abao'):
        return self.tracker.observe(name,generation,rows,count)
    def test_baseline_and_duplicate_polls_preserve_ids(self):
        rows,meta=self.observe([text(1,'旧消息')],3)
        self.assertEqual(meta['mode'],'baseline');self.assertNotIn('continuityAnchor',rows[0])
        again,meta=self.observe([text(1,'旧消息')])
        self.assertEqual(rows,again);self.assertEqual(meta['mode'],'overlap')
    def test_recreated_widgets_retain_unique_suffix_anchor_and_deliver_new_rows(self):
        before,_=self.observe([text(1,'背景'),text(2,'最后一句')])
        after,meta=self.observe([text(20,'背景'),text(21,'最后一句'),text(22,'小汐，看图')],1)
        self.assertEqual([r['id'] for r in after[:2]],[r['id'] for r in before])
        self.assertEqual(meta['mode'],'overlap');self.assertNotIn(after[-1]['id'],[r['id'] for r in before])
    def test_verified_unread_tail_retains_actual_old_anchor_without_replaying_prefix(self):
        before,_=self.observe([text(1,'旧视口最后一句')])
        after,meta=self.observe([text(10,'其他历史'),text(11,'小汐看图'),voice(12,'未播放')],2)
        self.assertEqual(meta['mode'],'verified_unread_tail')
        self.assertEqual(after[0]['id'],before[-1]['id'])
        self.assertEqual([r['text'] for r in after[1:]],['小汐看图','语音3"秒未播放'])
        again,_=self.observe([text(10,'其他历史'),text(11,'小汐看图'),voice(12,'未播放')])
        self.assertEqual(again[-1]['id'],after[-1]['id'])
    def test_no_count_cannot_bridge_missing_anchor(self):
        self.observe([text(1,'old')]);after,meta=self.observe([text(2,'小汐，历史命令')])
        self.assertEqual(meta['mode'],'gap');self.assertTrue(all(not r.get('continuityAnchor') for r in after))
    def test_unread_count_proves_duplicate_phrase_with_reused_native_id_is_fresh(self):
        before,_=self.observe([text(1,'小汐在吗')]);after,meta=self.observe([text(1,'小汐在吗')],1)
        self.assertEqual(meta['mode'],'verified_unread_tail');self.assertNotEqual(after[-1]['id'],before[-1]['id'])
    def test_voice_conversion_keeps_id_even_before_later_anchor(self):
        before,_=self.observe([voice(1,'未播放'),text(2,'之后的文字')])
        after,meta=self.observe([voice(1,'小汐，晚上好'),text(2,'之后的文字')])
        self.assertEqual([r['id'] for r in before],[r['id'] for r in after]);self.assertEqual(meta['mode'],'overlap')
    def test_other_generation_or_group_is_never_bridged(self):
        self.observe([text(1,'old')])
        for extra in [{'generation':'new'},{'name':'family'}]:
            with self.subTest(extra=extra):
                after,meta=self.observe([text(2,'new')],1,**extra)
                self.assertEqual(meta['mode'],'baseline');self.assertEqual(len(after),1)
    def test_ambiguous_repeated_suffix_without_unread_proof_remains_gap(self):
        self.observe([text(1,'好'),text(2,'好')]);after,meta=self.observe([text(10,'好'),text(11,'好'),text(12,'好')])
        self.assertEqual(meta['mode'],'gap')
    def test_large_unread_count_reports_omissions_and_does_not_invent_messages(self):
        self.observe([text(1,'old')]);after,meta=self.observe([text(2,'new')],20)
        self.assertEqual(meta['unreadOutsideViewport'],19);self.assertEqual(len(after),2)
    def test_send_verification_reads_do_not_consume_anchor_before_poll(self):
        before,_=self.observe([text(1,'old anchor')])
        self.observe([text(20,'unseen history'),text(21,'小汐看图')],1)
        after,_=self.observe([text(20,'unseen history'),text(21,'小汐看图')])
        self.assertEqual([r['text'] for r in after],['old anchor','小汐看图'])
        self.assertEqual(after[0]['id'],before[-1]['id'])
    def test_voice_widget_replacement_can_use_unique_unchanged_neighbor(self):
        before,_=self.observe([text(1,'unique lead-in'),voice(2,'未播放')])
        after,meta=self.observe([text(10,'unique lead-in'),voice(20,'小汐，晚上好')])
        self.assertEqual(after[-1]['id'],before[-1]['id']);self.assertEqual(meta['mode'],'overlap')
    def test_unanchored_replaced_voice_cannot_be_assumed_same_message(self):
        before,_=self.observe([voice(1,'未播放')]);after,meta=self.observe([voice(2,'小汐，晚上好')])
        self.assertNotEqual(before[0]['id'],after[0]['id']);self.assertEqual(meta['mode'],'gap')

if __name__=='__main__':unittest.main()
